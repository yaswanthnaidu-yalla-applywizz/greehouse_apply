import { parsePhoneNumberFromString } from 'libphonenumber-js';
import type { ScannedField } from '../types/index.js';
import { normalizeText } from './fingerprint.js';

const MAX_FACTS = 500;
const MAX_EVIDENCE_CHARS = 2200;
const MAX_FACT_VALUE_CHARS = 500;
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'can', 'could', 'do', 'does', 'for', 'from',
  'have', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our', 'please',
  'the', 'their', 'this', 'to', 'us', 'we', 'what', 'when', 'where', 'which', 'who',
  'why', 'will', 'with', 'you', 'your',
]);

type EvidenceFact = { path: string; value: string };

function phoneNumberFromText(value: string): string | null {
  const candidates = value.match(/(?:\+\s*)?(?:\(?\d{2,4}\)?[\s.-]*){2,4}\d{3,4}/g) || [];
  const normalized = candidates
    .map((candidate) => {
      const trimmed = candidate.trim();
      const digits = trimmed.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) return null;

      if (trimmed.startsWith('+') || digits.length > 10) {
        const parsed = parsePhoneNumberFromString(`+${digits}`, { extract: false });
        if (parsed?.isPossible()) return parsed.nationalNumber;
        if (trimmed.startsWith('+')) return null;
      }
      return digits;
    })
    .filter((candidate): candidate is string => Boolean(candidate));

  return normalized.length === 1 ? normalized[0] : null;
}

function isContactLine(line: string): boolean {
  return /@|linkedin|github|https?:\/\/|\|/i.test(line);
}

function firstResumeHeaderLines(resumeFacts: unknown, resumeText: string): string[] {
  const facts = resumeFacts && typeof resumeFacts === 'object'
    ? (resumeFacts as { rawSections?: Record<string, unknown> })
    : {};
  const summary = facts.rawSections?.summary;
  const source = typeof summary === 'string' && summary.trim() ? summary : resumeText;
  return source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 8);
}

export function isPhoneNumberField(field: Pick<ScannedField, 'label' | 'name' | 'fieldId'>): boolean {
  const combined = `${field.label} ${field.name} ${field.fieldId}`;
  if (/\b(?:country|calling|dialing)\s*code\b|\bphone\s*extension\b/i.test(combined)) return false;
  return /\b(?:phone|mobile|cell|telephone|contact number)\b/i.test(combined);
}

export function extractResumePhone(resumeFacts: unknown, resumeText = ''): string | null {
  const headerLines = firstResumeHeaderLines(resumeFacts, resumeText);
  const contactLines = headerLines.filter(isContactLine);
  for (const line of contactLines) {
    const phone = phoneNumberFromText(line);
    if (phone) return phone;
  }
  return null;
}

export function resumeAnswerMatchesPhone(
  answer: string,
  resumeFacts: unknown,
  resumeText = ''
): string | null {
  const resumePhone = extractResumePhone(resumeFacts, resumeText);
  const answerPhone = phoneNumberFromText(answer);
  return resumePhone && answerPhone === resumePhone ? resumePhone : null;
}

function collectFacts(value: unknown, path: string, facts: EvidenceFact[], depth = 0): void {
  if (facts.length >= MAX_FACTS || depth > 7 || value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value).trim();
    if (!text) return;
    if (text.length <= MAX_FACT_VALUE_CHARS) {
      facts.push({ path, value: text });
      return;
    }
    for (const [index, line] of text.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).entries()) {
      if (facts.length >= MAX_FACTS) break;
      facts.push({ path: `${path}[${index}]`, value: line.slice(0, MAX_FACT_VALUE_CHARS) });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 30).forEach((item, index) => collectFacts(item, `${path}[${index}]`, facts, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:resume_text|resume_url|resume_storage_path|id|created_at|updated_at)$/i.test(key)) continue;
      collectFacts(child, path ? `${path}.${key}` : key, facts, depth + 1);
      if (facts.length >= MAX_FACTS) break;
    }
  }
}

function questionTokens(text: string): string[] {
  return Array.from(new Set(normalizeText(text).split(/\s+/).filter((token) =>
    token.length > 2 && !STOP_WORDS.has(token)
  )));
}

function scoreFact(question: string, tokens: string[], fact: EvidenceFact): number {
  const path = normalizeText(fact.path);
  const value = normalizeText(fact.value);
  let score = tokens.reduce((total, token) =>
    total + (path.includes(token) ? 3 : 0) + (value.includes(token) ? 1 : 0), 0);

  const groups: Array<[RegExp, RegExp]> = [
    [/\b(?:phone|mobile|cell|telephone|contact number)\b/i, /phone|mobile|telephone|contact|raw sections summary/i],
    [/\b(?:country|location|state|zip|address)\b/i, /country|location|state of residence|zip or country|address/i],
    [/\b(?:school|university|college|degree|education|graduate|graduation|major)\b/i, /education|school|university|college|degree|graduation/i],
    [/\b(?:experience|employment|work history|career|skill|technology|project)\b/i, /experience|work|skill|project|summary/i],
    [/\b(?:salary|compensation|pay|wage)\b/i, /salary|compensation|pay/i],
    [/\b(?:visa|sponsor|authorized|authorization|eligible to work)\b/i, /visa|sponsor|authorization|work authorization|eligible to work/i],
    [/\b(?:gender|race|ethnicity|veteran|disability|hispanic|latino)\b/i, /gender|race|ethnicity|veteran|disability|hispanic|latino/i],
  ];
  for (const [questionPattern, factPattern] of groups) {
    if (questionPattern.test(question) && factPattern.test(path)) score += 12;
  }
  return score;
}

export function buildQuestionRelevantEvidence(
  field: Pick<ScannedField, 'label' | 'name' | 'fieldId' | 'type'>,
  profile: object,
  resumeText = '',
  resumeFactsOverride?: unknown
): string {
  const candidate = profile as Record<string, unknown>;
  const resumeFacts = resumeFactsOverride ?? candidate.resume_facts ?? candidate.resumeFacts;
  const phoneField = isPhoneNumberField(field);
  const facts: EvidenceFact[] = [];

  if (phoneField) {
    const phone = extractResumePhone(resumeFacts, resumeText);
    return phone ? `Resume contact phone: ${phone}` : '';
  }

  for (const key of [
    'country', 'countryCode', 'country_code', 'location', 'workAuthorization',
    'work_authorization', 'requiresSponsorship', 'requires_sponsorship', 'education',
    'workExperience', 'work_experience', 'demographics',
  ]) {
    if (candidate[key] !== undefined) collectFacts(candidate[key], `profile.${key}`, facts);
  }
  collectFacts(candidate.raw_api_payload, 'raw_api_payload', facts);
  collectFacts(resumeFacts, 'resume_facts', facts);

  const question = `${field.label} ${field.name} ${field.fieldId}`;
  const tokens = questionTokens(question);
  const selected = facts
    .map((fact, index) => ({ fact, index, score: scoreFact(question, tokens, fact) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const lines: string[] = [];
  let totalChars = 0;
  for (const { fact } of selected) {
    const line = `${fact.path}: ${fact.value.slice(0, MAX_FACT_VALUE_CHARS)}`;
    if (totalChars + line.length > MAX_EVIDENCE_CHARS) continue;
    lines.push(line);
    totalChars += line.length + 1;
  }
  return lines.join('\n');
}
