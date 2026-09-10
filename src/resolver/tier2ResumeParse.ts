/**
 * @fileoverview Tier 2 Answer Resolution: PDF Resume Parsing & Cache.
 * Source Tag: 'resume_parse', resolvedByTier: 2
 */

import fs from 'fs';
import _pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { getProfile, updateParsedResume } from '../db/profiles.js';
import { downloadResumeTempFile } from '../db/storage.js';
import { normalizeText } from './fingerprint.js';
import type { ResolvedField, ScannedField } from '../types/index.js';

export interface ParsedResumeStructured {
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  linkedinUrl?: string;
  skills: string[];
  experience: Array<{
    company: string;
    title: string;
    duration: string;
    description: string;
  }>;
  education: Array<{
    institution: string;
    degree: string;
    year: string;
  }>;
  rawSections: Record<string, string>;
}

export interface ResumeParsedRow {
  id?: string;
  applywizz_id: string;
  raw_text: string;
  structured: ParsedResumeStructured | Record<string, any>;
  parse_library?: string;
  parse_version?: string;
  parsed_at?: string;
  parse_failed?: boolean;
  parse_error?: string | null;
}

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
    const eduLines = eduText.split('\n').map((l) => l.trim()).filter(Boolean);
    let currentInst = '';
    let currentDeg = '';
    let currentYr = '';

    for (const l of eduLines) {
      const yearMatch = l.match(/\b(20\d{2}|19\d{2})\b/);
      if (yearMatch && !currentYr) currentYr = yearMatch[0];

      const degreeMatch = l.match(/\b(bachelor|master|b\.s|m\.s|ph\.d|associate|degree)\b/i);
      if (degreeMatch && !currentDeg) currentDeg = l.substring(0, 60);

      const instMatch = l.match(/([A-Z][a-zA-Z\s.,'-]+(?:College|University|Institute|School|Academy|Polytechnic)[a-zA-Z\s.,'-]*)/i);
      if (instMatch && !currentInst) {
        currentInst = instMatch[0].trim().substring(0, 60);
      } else if (/(college|university|institute|school)/i.test(l) && !currentInst) {
        currentInst = l.substring(0, 60);
      }
    }

    if (currentInst || currentDeg) {
      education.push({
        institution: currentInst || 'University on file',
        degree: currentDeg || "Master's Degree",
        year: currentYr || '',
      });
    }
  }

  // Parse experience
  const expText = rawSections['experience'] || rawSections['work experience'] || rawSections['employment'] || '';
  if (expText) {
    const expLines = expText.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < Math.min(expLines.length, 10); i++) {
      const line = expLines[i];
      if (/(engineer|developer|architect|consultant|analyst|specialist|manager|administrator|lead)/i.test(line)) {
        const nextLine = expLines[i + 1] || '';
        experience.push({
          company: nextLine.length > 2 && nextLine.length < 50 ? nextLine : 'Current Company',
          title: line.slice(0, 60),
          duration: 'Present',
          description: line,
        });
        break;
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
 * Retrieves the parsed resume from Supabase cache, or downloads from Supabase Storage and parses.
 * Never fetches from external URLs during resolution.
 */
export async function getOrParseResume(applywizzId: string): Promise<ResumeParsedRow | null> {
  // 1. Check candidate profile in DB
  try {
    const profile = await getProfile(applywizzId);
    if (profile?.resume_text && profile.resume_text.trim().length > 0) {
      return {
        applywizz_id: applywizzId,
        raw_text: profile.resume_text,
        structured: profile.resume_facts || { skills: [], experience: [], education: [], rawSections: {} },
        parse_failed: false,
      };
    }
  } catch (err: any) {
    console.warn(`[Tier 2] Profile resume lookup failed for ${applywizzId}: ${err.message}`);
  }

  // 2. Download from local cache / on-demand remote URL and parse
  let tempPath: string | null = null;
  try {
    tempPath = await downloadResumeTempFile(applywizzId);
    if (!tempPath || !fs.existsSync(tempPath)) {
      return null;
    }
    const dataBuffer = fs.readFileSync(tempPath);
    const parsed = await pdfParse(dataBuffer);

    let rawText = parsed.text || '';

    // Extract embedded hyperlink annotations (e.g. /URI (https://...)) directly from PDF binary
    try {
      const bufferStr = dataBuffer.toString('latin1');
      const uriRegex = /\/URI\s*\(([^)]+)\)/gi;
      const extractedLinks: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = uriRegex.exec(bufferStr)) !== null) {
        if (match[1]) {
          const cleanUri = match[1].trim();
          if (/^https?:\/\//i.test(cleanUri) || /^mailto:/i.test(cleanUri)) {
            extractedLinks.push(cleanUri);
          }
        }
      }
      if (extractedLinks.length > 0) {
        rawText += '\n\nEmbedded PDF Links:\n' + extractedLinks.join('\n');
      }
    } catch {}

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

    // Cache directly on candidate profile
    await updateParsedResume(applywizzId, rawText, structured);
    return record;
  } catch (err: any) {
    console.warn(`[Tier 2] PDF parse failed for ${applywizzId}: ${err.message}`);
    return null;
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

  // 0. Cover Letter - NEVER fill cover letter
  if (/cover\s*letter|cover_letter/i.test(combined)) {
    return null;
  }

  // 1. Candidate Name extraction (First Name, Last Name, Full Name)
  if (
    /(first|given|fore)\s*name/i.test(combined) ||
    field.fieldId === 'first_name' ||
    field.name === 'first_name' ||
    /(last|family|sur)\s*name/i.test(combined) ||
    field.fieldId === 'last_name' ||
    field.name === 'last_name' ||
    /(full|candidate)\s*name/i.test(combined) ||
    field.fieldId === 'full_name' ||
    field.name === 'full_name'
  ) {
    const lines = resume.raw_text.split('\n').map((l) => l.trim()).filter(Boolean);
    let extractedName: { first: string; last: string; full: string } | null = null;

    for (const line of lines.slice(0, 6)) {
      if (!/@|http|linkedin|github|\+?\d{3}|summary|objective|skills|experience/i.test(line)) {
        const cleanLine = line.replace(/[^a-zA-Z\s.-]/g, '').trim();
        const parts = cleanLine.split(/\s+/).filter((p) => p.length > 1);
        if (parts.length >= 2 && parts.length <= 5) {
          extractedName = {
            first: parts[0],
            last: parts.slice(1).join(' '),
            full: parts.join(' '),
          };
          break;
        }
      }
    }

    if (extractedName) {
      const isFirst = /(first|given|fore)\s*name/i.test(combined) || field.fieldId === 'first_name' || field.name === 'first_name';
      const isLast = /(last|family|sur)\s*name/i.test(combined) || field.fieldId === 'last_name' || field.name === 'last_name';
      const targetVal = isFirst ? extractedName.first : isLast ? extractedName.last : extractedName.full;

      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: targetVal,
        source: 'resume_parse',
        resolvedByTier: 2,
        confidence: 0.95,
      };
    }
  }

  // 2. Phone number extraction (strip +1 country code)
  if (/\bphone\b|mobile|cell|telephone/i.test(combined)) {
    const phoneMatch = resume.raw_text.match(/(?:\+?1[-.\s]*)?\(?\d{3}\)?[-.\s]*\d{3}[-.\s]*\d{4}\b/);
    if (phoneMatch && phoneMatch[0]) {
      let cleanPhone = phoneMatch[0].trim();
      cleanPhone = cleanPhone.replace(/^\+?1[\s.-]*/, '').replace(/^\+/, '').replace(/\s+/g, ' ').trim();
      const digitsOnly = cleanPhone.replace(/\D/g, '');
      if (digitsOnly.length >= 10) {
        return {
          fieldId: field.fieldId,
          name: field.name,
          type: field.type,
          label: field.label,
          value: cleanPhone,
          source: 'resume_parse',
          resolvedByTier: 2,
          confidence: 0.95,
        };
      }
    }
  }

  // 1. LinkedIn URL extraction
  if (/linkedin/i.test(combined)) {
    const linkedinMatch = resume.raw_text.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_\-]+/i) ||
                          resume.raw_text.match(/linkedin\.com\/in\/[a-zA-Z0-9_\-]+/i);
    if (linkedinMatch) {
      const url = linkedinMatch[0].startsWith('http') ? linkedinMatch[0] : `https://${linkedinMatch[0]}`;
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: url,
        source: 'resume_parse',
        resolvedByTier: 2,
        confidence: 0.95,
      };
    }
  }

  // 2. GitHub URL extraction
  if (/github/i.test(combined)) {
    const githubMatch = resume.raw_text.match(/https?:\/\/(?:www\.)?github\.com\/[a-zA-Z0-9_\-]+/i) ||
                        resume.raw_text.match(/github\.com\/[a-zA-Z0-9_\-]+/i);
    if (githubMatch) {
      const url = githubMatch[0].startsWith('http') ? githubMatch[0] : `https://${githubMatch[0]}`;
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: url,
        source: 'resume_parse',
        resolvedByTier: 2,
        confidence: 0.95,
      };
    }
  }

  // 2b. Portfolio / Personal Website URL extraction
  if (/portfolio|website|personal site|blog/i.test(combined)) {
    const portfolioMatch =
      resume.raw_text.match(/https?:\/\/(?:www\.)?[a-zA-Z0-9_\-.]+\.(?:vercel\.app|github\.io|netlify\.app|dev|me|io|com|org)[^\s\)\>"]*/i) ||
      resume.raw_text.match(/[a-zA-Z0-9_\-.]+\.(?:vercel\.app|github\.io|netlify\.app)[^\s\)\>"]*/i);
    if (portfolioMatch) {
      const url = portfolioMatch[0].startsWith('http') ? portfolioMatch[0] : `https://${portfolioMatch[0]}`;
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: url,
        source: 'resume_parse',
        resolvedByTier: 2,
        confidence: 0.95,
      };
    }
  }

  // 3. Skills / Technologies list
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

  // 4. GPA / Graduation details if present in raw text
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

  // 5. School / University / Alma Mater
  if (/(school|university|college|alma mater|institution|degree granting)/i.test(combined)) {
    const instMatch = resume.raw_text.match(/([A-Z][a-zA-Z\s.,'-]+(?:College|University|Institute|School|Academy|Polytechnic)[a-zA-Z\s.,'-]*)/i);
    if (instMatch) {
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: instMatch[0].trim(),
        source: 'resume_parse',
        resolvedByTier: 2,
        confidence: 0.95,
      };
    }
    const edu = structured.education && structured.education[0];
    if (edu && edu.institution) {
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: edu.institution,
        source: 'resume_parse',
        resolvedByTier: 2,
        confidence: 0.9,
      };
    }
  }

  // 6. Degree / Highest Education / Level of Education
  if (/(degree|highest education|level of education|education level)/i.test(combined)) {
    if (field.options && field.options.length > 0) {
      for (const opt of field.options) {
        const optLower = opt.toLowerCase();
        if (/master/i.test(optLower) && /master|m\.s|m\.sc/i.test(resume.raw_text)) {
          return { fieldId: field.fieldId, name: field.name, type: field.type, label: field.label, value: opt, source: 'resume_parse', resolvedByTier: 2, confidence: 0.95 };
        }
        if (/bachelor/i.test(optLower) && /bachelor|b\.s|b\.tech|b\.e/i.test(resume.raw_text)) {
          return { fieldId: field.fieldId, name: field.name, type: field.type, label: field.label, value: opt, source: 'resume_parse', resolvedByTier: 2, confidence: 0.95 };
        }
        if (/doctorate|ph\.?d/i.test(optLower) && /ph\.?d|doctorate/i.test(resume.raw_text)) {
          return { fieldId: field.fieldId, name: field.name, type: field.type, label: field.label, value: opt, source: 'resume_parse', resolvedByTier: 2, confidence: 0.95 };
        }
      }
    }
    const edu = structured.education && structured.education[0];
    if (edu && edu.degree) {
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: edu.degree,
        source: 'resume_parse',
        resolvedByTier: 2,
        confidence: 0.9,
      };
    }
  }

  // 7. Major / Discipline / Field of Study
  if (/(major|discipline|field of study|area of study)/i.test(combined)) {
    const majors = [
      'Computer Science',
      'Information Technology',
      'Data Science',
      'Software Engineering',
      'Electrical Engineering',
      'Information Systems',
      'Computer Engineering',
    ];
    for (const m of majors) {
      if (new RegExp(`\\b${m}\\b`, 'i').test(resume.raw_text)) {
        return {
          fieldId: field.fieldId,
          name: field.name,
          type: field.type,
          label: field.label,
          value: m,
          source: 'resume_parse',
          resolvedByTier: 2,
          confidence: 0.9,
        };
      }
    }
  }

  // 8. Current / Most Recent Employer
  if (/(current employer|current company|most recent employer|most recent company|employer name)/i.test(combined)) {
    const exp = structured.experience && structured.experience[0];
    if (exp && exp.company && exp.company !== 'Current Company') {
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: exp.company,
        source: 'resume_parse',
        resolvedByTier: 2,
        confidence: 0.9,
      };
    }
  }

  // 9. Current / Most Recent Job Title
  if (/(current title|current role|most recent title|most recent role|job title)/i.test(combined) && !/company|employer/i.test(combined)) {
    const exp = structured.experience && structured.experience[0];
    if (exp && exp.title) {
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: exp.title,
        source: 'resume_parse',
        resolvedByTier: 2,
        confidence: 0.9,
      };
    }
  }

  // 10. Years of Experience
  if (/(years of experience|how many years|total experience)/i.test(combined)) {
    const yearsMatch = resume.raw_text.match(/(\d+)\+?\s*years(?:\s+of)?\s+experience/i);
    if (yearsMatch) {
      const yearsNum = parseInt(yearsMatch[1], 10);
      let val = `${yearsNum}`;
      if (field.options && field.options.length > 0) {
        const matched = field.options.find((o) => {
          const numMatch = o.match(/\d+/);
          return numMatch && Math.abs(parseInt(numMatch[0], 10) - yearsNum) <= 1;
        });
        if (matched) val = matched;
      }
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: val,
        source: 'resume_parse',
        resolvedByTier: 2,
        confidence: 0.9,
      };
    }
  }

  // 11. Skill & Technology Experience Inquiries (e.g., "Do you have experience with Python?")
  if (
    /(do you have experience|have you worked with|experience with|familiar with|proficient with|knowledge of)/i.test(combined) ||
    (field.options && field.options.length === 2 && field.options.some((o) => /^yes/i.test(o.trim())))
  ) {
    const techRegex = /\b(python|java|c\+\+|c#|golang|go|rust|ruby|php|sql|nosql|mysql|postgresql|postgres|mongodb|snowflake|databricks|bigquery|aws|azure|gcp|docker|kubernetes|terraform|airflow|spark|kafka|react|angular|vue|node|express|django|flask|spring|fastapi|pandas|numpy|scikit|tableau|power bi|looker|git|ci\/cd|linux)\b/i;
    const match = field.label.match(techRegex);
    if (match) {
      const tech = match[0];
      const hasSkill = new RegExp(`\\b${tech}\\b`, 'i').test(resume.raw_text);
      if (hasSkill) {
        let yesVal = 'Yes';
        if (field.options && field.options.length > 0) {
          const foundYes = field.options.find((o) => /^yes/i.test(o.trim()) || o.trim() === '1');
          if (foundYes) yesVal = foundYes;
        }
        return {
          fieldId: field.fieldId,
          name: field.name,
          type: field.type,
          label: field.label,
          value: yesVal,
          source: 'resume_parse',
          resolvedByTier: 2,
          confidence: 0.95,
        };
      }
    }
  }

  // 12. Multiple Choice Option Matching against Resume Text
  if ((field.type === 'select' || field.type === 'radio') && field.options && field.options.length > 1) {
    let bestOption: string | null = null;
    let maxMentions = 0;

    for (const opt of field.options) {
      const cleanOpt = opt.trim();
      if (/^(select|please select|choose|other|none|n\/a|not applicable|--)/i.test(cleanOpt)) {
        continue;
      }
      if (cleanOpt.length < 2) continue;

      const escaped = cleanOpt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const count = (resume.raw_text.match(new RegExp(`\\b${escaped}\\b`, 'gi')) || []).length;
      if (count > maxMentions) {
        maxMentions = count;
        bestOption = cleanOpt;
      }
    }

    if (bestOption && maxMentions >= 2) {
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: bestOption,
        source: 'resume_parse',
        resolvedByTier: 2,
        confidence: 0.85,
      };
    }
  }

  return null;
}

export default resolveTier2;
