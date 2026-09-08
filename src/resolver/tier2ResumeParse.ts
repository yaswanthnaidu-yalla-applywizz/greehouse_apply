/**
 * @fileoverview Tier 2 Answer Resolution: PDF Resume Parsing & Cache.
 * Source Tag: 'resume_parse', resolvedByTier: 2
 */

import fs from 'fs';
import _pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { getParsedResume, upsertParsedResume, type ResumeParsedRow, type ParsedResumeStructured } from '../db/resumeParsed.js';
import { downloadResumeTempFile } from '../db/storage.js';
import { normalizeText } from './fingerprint.js';
import type { ResolvedField, ScannedField } from '../types/index.js';

export type { ResumeParsedRow, ParsedResumeStructured };
const pdfParse: (dataBuffer: Buffer, options?: any) => Promise<{ text: string }> =
  (_pdfParse as any).default || _pdfParse;

/**
 * Parses raw resume text into structured components.
 */
function extractStructuredSections(rawText: string): ParsedResumeStructured {
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  const rawSections: Record<string, string> = {};
  const skills: string[] = [];
  const education: Array<{ institution: string; degree: string; year: string }> = [];
  const experience: Array<{ company: string; title: string; duration: string; description: string }> = [];

  let currentSection = 'summary';
  rawSections[currentSection] = '';

  const sectionHeaders = [
    'experience',
    'work experience',
    'employment',
    'education',
    'skills',
    'technical skills',
    'projects',
    'certifications',
    'summary',
  ];

  for (const line of lines) {
    const lower = line.toLowerCase().replace(/[:\-_]/g, '').trim();
    const matchedHeader = sectionHeaders.find((h) => lower === h || lower.startsWith(`${h} `));

    if (matchedHeader) {
      currentSection = matchedHeader;
      if (!rawSections[currentSection]) {
        rawSections[currentSection] = '';
      }
    } else {
      rawSections[currentSection] = (rawSections[currentSection] ? `${rawSections[currentSection]}\n` : '') + line;
    }
  }

  // Parse skills
  const skillsText = rawSections['skills'] || rawSections['technical skills'] || '';
  if (skillsText) {
    const tokens = skillsText
      .split(/[,|•·\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 1 && s.length < 40 && !/^(skills|proficient in|languages|tools):?$/i.test(s));
    skills.push(...Array.from(new Set(tokens)));
  }

  // Parse education
  const eduText = rawSections['education'] || '';
  if (eduText) {
    const eduLines = eduText.split('\n');
    for (const l of eduLines) {
      const yearMatch = l.match(/\b(20\d{2}|19\d{2})\b/);
      const degreeMatch = l.match(/\b(bachelor|master|b\.s|m\.s|ph\.d|associate|degree)\b/i);
      if (yearMatch || degreeMatch) {
        education.push({
          institution: l.substring(0, 50),
          degree: degreeMatch ? degreeMatch[0] : 'Degree',
          year: yearMatch ? yearMatch[0] : '',
        });
      }
    }
  }

  return {
    skills,
    experience,
    education,
    rawSections,
  };
}

/**
 * Retrieves the parsed resume from Supabase cache, or downloads the PDF and parses it.
 */
export async function getOrParseResume(applywizzId: string): Promise<ResumeParsedRow | null> {
  // 1. Check DB cache
  try {
    const cached = await getParsedResume(applywizzId);
    if (cached && cached.raw_text && !cached.parse_failed) {
      return cached;
    }
  } catch (err: any) {
    console.warn(`[Tier 2] Cache lookup failed for ${applywizzId}: ${err.message}`);
  }

  // 2. Download from Supabase Storage and parse
  let tempPath: string | null = null;
  try {
    tempPath = await downloadResumeTempFile(applywizzId);
    const dataBuffer = fs.readFileSync(tempPath);
    const parsed = await pdfParse(dataBuffer);

    const rawText = parsed.text || '';
    const structured = extractStructuredSections(rawText);

    const record: ResumeParsedRow = {
      applywizz_id: applywizzId,
      raw_text: rawText,
      structured,
      parse_library: 'pdf-parse',
      parse_version: '1.1.1',
      parsed_at: new Date().toISOString(),
      parse_failed: false,
    };

    // Cache in DB
    await upsertParsedResume(record);
    return record;
  } catch (err: any) {
    console.warn(`[Tier 2] PDF parse failed for ${applywizzId}: ${err.message}`);
    const failedRecord: ResumeParsedRow = {
      applywizz_id: applywizzId,
      raw_text: '',
      structured: { skills: [], experience: [], education: [], rawSections: {} },
      parse_library: 'pdf-parse',
      parse_failed: true,
      parse_error: err.message,
    };
    try {
      await upsertParsedResume(failedRecord);
    } catch {}
    return null;
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {}
    }
  }
}

/**
 * Attempts Tier 2 resolution from parsed resume cache.
 *
 * @returns ResolvedField with source: 'resume_parse', resolvedByTier: 2, or null if miss.
 */
export async function resolveTier2(
  applywizzId: string,
  field: ScannedField,
  parsedResumeCache?: ResumeParsedRow | null
): Promise<ResolvedField | null> {
  const resume = parsedResumeCache !== undefined ? parsedResumeCache : await getOrParseResume(applywizzId);
  if (!resume || !resume.raw_text || resume.parse_failed) {
    return null;
  }

  const normLabel = normalizeText(field.label);
  const normName = normalizeText(field.name);
  const combined = `${normLabel} ${normName}`;
  const structured = resume.structured as ParsedResumeStructured;

  // 1. Skills / Technologies list
  if (/(skills|technologies|tools|languages you know|tech stack)/i.test(combined)) {
    if (structured.skills && structured.skills.length > 0) {
      if (field.type === 'textarea' || field.type === 'text') {
        return {
          fieldId: field.fieldId,
          name: field.name,
          type: field.type,
          label: field.label,
          value: structured.skills.slice(0, 15).join(', '),
          source: 'resume_parse',
          resolvedByTier: 2,
          confidence: 0.9,
        };
      }
    }
  }

  // 2. Summary / Bio / Objective
  if (/(summary|objective|about yourself|short bio|overview)/i.test(combined) && field.type === 'textarea') {
    const summaryText = structured.rawSections?.['summary'] || structured.rawSections?.['experience'];
    if (summaryText && summaryText.trim().length > 30) {
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: summaryText.trim().substring(0, 800),
        source: 'resume_parse',
        resolvedByTier: 2,
        confidence: 0.85,
      };
    }
  }

  // 3. GPA / Graduation details if present in raw text
  if (/gpa|grade point average/i.test(combined)) {
    const gpaMatch = resume.raw_text.match(/\bGPA[:\s]*([0-4]\.\d{1,2}(?:\s*\/\s*4(?:\.0)?)?)\b/i);
    if (gpaMatch) {
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: gpaMatch[1],
        source: 'resume_parse',
        resolvedByTier: 2,
        confidence: 0.95,
      };
    }
  }

  return null;
}

export default resolveTier2;
