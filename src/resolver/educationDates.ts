/**
 * @fileoverview Education Date Subfields Extraction & Resolution.
 * Deterministically maps Greenhouse / Ashby education date subfields
 * (start_date_year, end_date_year, start_date_month, end_date_month)
 * from parsed resume facts, applying academic fallback months (September/May)
 * when year facts are proven.
 */

import { matchChoiceOption } from '../utils/choiceOptions.js';

export interface EducationDateResult {
  value: string;
  confidence: number;
}

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTH_MAP: Record<string, { name: string; num: string; short: string }> = {
  jan: { name: 'January', num: '01', short: 'Jan' },
  january: { name: 'January', num: '01', short: 'Jan' },
  '01': { name: 'January', num: '01', short: 'Jan' },
  '1': { name: 'January', num: '01', short: 'Jan' },

  feb: { name: 'February', num: '02', short: 'Feb' },
  february: { name: 'February', num: '02', short: 'Feb' },
  '02': { name: 'February', num: '02', short: 'Feb' },
  '2': { name: 'February', num: '02', short: 'Feb' },

  mar: { name: 'March', num: '03', short: 'Mar' },
  march: { name: 'March', num: '03', short: 'Mar' },
  '03': { name: 'March', num: '03', short: 'Mar' },
  '3': { name: 'March', num: '03', short: 'Mar' },

  apr: { name: 'April', num: '04', short: 'Apr' },
  april: { name: 'April', num: '04', short: 'Apr' },
  '04': { name: 'April', num: '04', short: 'Apr' },
  '4': { name: 'April', num: '04', short: 'Apr' },

  may: { name: 'May', num: '05', short: 'May' },
  '05': { name: 'May', num: '05', short: 'May' },
  '5': { name: 'May', num: '05', short: 'May' },

  jun: { name: 'June', num: '06', short: 'Jun' },
  june: { name: 'June', num: '06', short: 'Jun' },
  '06': { name: 'June', num: '06', short: 'Jun' },
  '6': { name: 'June', num: '06', short: 'Jun' },

  jul: { name: 'July', num: '07', short: 'Jul' },
  july: { name: 'July', num: '07', short: 'Jul' },
  '07': { name: 'July', num: '07', short: 'Jul' },
  '7': { name: 'July', num: '07', short: 'Jul' },

  aug: { name: 'August', num: '08', short: 'Aug' },
  august: { name: 'August', num: '08', short: 'Aug' },
  '08': { name: 'August', num: '08', short: 'Aug' },
  '8': { name: 'August', num: '08', short: 'Aug' },

  sep: { name: 'September', num: '09', short: 'Sep' },
  september: { name: 'September', num: '09', short: 'Sep' },
  '09': { name: 'September', num: '09', short: 'Sep' },
  '9': { name: 'September', num: '09', short: 'Sep' },

  oct: { name: 'October', num: '10', short: 'Oct' },
  october: { name: 'October', num: '10', short: 'Oct' },
  '10': { name: 'October', num: '10', short: 'Oct' },

  nov: { name: 'November', num: '11', short: 'Nov' },
  november: { name: 'November', num: '11', short: 'Nov' },
  '11': { name: 'November', num: '11', short: 'Nov' },

  dec: { name: 'December', num: '12', short: 'Dec' },
  december: { name: 'December', num: '12', short: 'Dec' },
  '12': { name: 'December', num: '12', short: 'Dec' },
};

function parseYearNumber(val: unknown): number | null {
  if (val === undefined || val === null) return null;
  if (typeof val === 'number' && Number.isFinite(val) && val >= 1900 && val <= 2100) {
    return Math.floor(val);
  }
  const s = String(val).trim();
  const m = s.match(/\b(19\d{2}|20\d{2})\b/);
  return m ? parseInt(m[1], 10) : null;
}

function parseMonthName(val: unknown): string | null {
  if (val === undefined || val === null) return null;
  const s = String(val).trim().toLowerCase();
  for (const [key, meta] of Object.entries(MONTH_MAP)) {
    if (new RegExp(`\\b${key}\\b`, 'i').test(s)) {
      return meta.name;
    }
  }
  return null;
}

function alignMonthOption(monthName: string, options?: string[]): string {
  if (!options || options.length === 0) return monthName;

  // 1. Direct match or choice match
  const choiceMatch = matchChoiceOption(monthName, options);
  if (choiceMatch) return choiceMatch;

  const meta = MONTH_MAP[monthName.toLowerCase()];
  if (!meta) return monthName;

  // 2. Numeric 2-digit match ('09', '05')
  const twoDigit = options.find((opt) => opt.trim() === meta.num);
  if (twoDigit) return twoDigit;

  // 3. Numeric 1-digit match ('9', '5')
  const singleDigit = options.find((opt) => opt.trim() === String(parseInt(meta.num, 10)));
  if (singleDigit) return singleDigit;

  // 4. Short name match ('Sep', 'May')
  const shortMatch = options.find((opt) => opt.trim().toLowerCase() === meta.short.toLowerCase());
  if (shortMatch) return shortMatch;

  // 5. Options like '09 - September' or 'September (09)'
  const compoundMatch = options.find((opt) => {
    const l = opt.toLowerCase();
    return l.includes(meta.name.toLowerCase()) || l.includes(meta.num);
  });
  if (compoundMatch) return compoundMatch;

  return monthName;
}

function alignYearOption(yearStr: string, options?: string[]): string {
  if (!options || options.length === 0) return yearStr;
  const direct = options.find((opt) => opt.trim() === yearStr);
  if (direct) return direct;
  return yearStr;
}

type SubfieldType = 'start_year' | 'end_year' | 'start_month' | 'end_month' | null;

function detectSubfieldType(label: string, name?: string, fieldId?: string): SubfieldType {
  const combined = `${fieldId || ''} ${name || ''} ${label}`
    .toLowerCase()
    .replace(/[-_]/g, ' ');

  // Start year
  if (
    /\b(?:start(?:\s+date)?\s+year|from\s+year)\b/i.test(combined) ||
    (/\b(?:start|from)\b/i.test(combined) && /\byear\b/i.test(combined) && !/\b(?:end|to|grad|completion)\b/i.test(combined))
  ) {
    return 'start_year';
  }

  // End year
  if (
    /\b(?:end(?:\s+date)?\s+year|to\s+year|grad(?:uation)?\s+year|completion\s+year)\b/i.test(combined) ||
    (/\b(?:end|to|grad|graduation|completion)\b/i.test(combined) && /\byear\b/i.test(combined) && !/\b(?:start|from)\b/i.test(combined))
  ) {
    return 'end_year';
  }

  // Start month
  if (
    /\b(?:start(?:\s+date)?\s+month|from\s+month)\b/i.test(combined) ||
    (/\b(?:start|from)\b/i.test(combined) && /\bmonth\b/i.test(combined) && !/\b(?:end|to|grad|completion)\b/i.test(combined))
  ) {
    return 'start_month';
  }

  // End month
  if (
    /\b(?:end(?:\s+date)?\s+month|to\s+month|grad(?:uation)?\s+month|completion\s+month)\b/i.test(combined) ||
    (/\b(?:end|to|grad|graduation|completion)\b/i.test(combined) && /\bmonth\b/i.test(combined) && !/\b(?:start|from)\b/i.test(combined))
  ) {
    return 'end_month';
  }

  return null;
}

/**
 * Extracts and maps education date subfield answers from parsed resume education facts.
 *
 * @param label - Field label (e.g. 'Start date year', 'End date month')
 * @param name - Field name attribute
 * @param fieldId - Field identifier
 * @param educationFacts - Array of candidate education objects or structured education records
 * @param options - Available field dropdown / radio options for alignment
 */
export function extractEducationDateSubfield(
  label: string,
  name?: string,
  fieldId?: string,
  educationFacts?: any[] | any,
  options?: string[]
): EducationDateResult | null {
  const subfieldType = detectSubfieldType(label, name, fieldId);
  if (!subfieldType) return null;

  let facts: any[] = [];
  if (Array.isArray(educationFacts)) {
    facts = educationFacts;
  } else if (educationFacts && typeof educationFacts === 'object') {
    if (Array.isArray(educationFacts.education)) {
      facts = educationFacts.education;
    } else {
      facts = [educationFacts];
    }
  }

  if (facts.length === 0) return null;

  // Locate first education record that contains date or degree information
  let explicitStartYear: number | null = null;
  let explicitEndYear: number | null = null;
  let explicitStartMonth: string | null = null;
  let explicitEndMonth: string | null = null;
  let isMasters = false;
  let hasAnyYear = false;

  for (const fact of facts) {
    if (!fact || typeof fact !== 'object') continue;

    const degreeStr = String(fact.degree || fact.degree_name || fact.degreeName || fact.title || '').trim();
    if (/\b(?:master|m\.?s|m\.?sc|mba|m\.?tech|m\.?eng)\b/i.test(degreeStr)) {
      isMasters = true;
    }

    // Explicit start year
    if (explicitStartYear === null) {
      explicitStartYear =
        parseYearNumber(fact.start_year) ??
        parseYearNumber(fact.startYear) ??
        parseYearNumber(fact.fromYear) ??
        parseYearNumber(fact.startDate) ??
        null;
    }

    // Explicit end year / graduation year
    if (explicitEndYear === null) {
      explicitEndYear =
        parseYearNumber(fact.end_year) ??
        parseYearNumber(fact.endYear) ??
        parseYearNumber(fact.gradYear) ??
        parseYearNumber(fact.graduation_year) ??
        parseYearNumber(fact.graduationYear) ??
        parseYearNumber(fact.endDate) ??
        parseYearNumber(fact.graduationDate) ??
        null;
    }

    // General year field: could be a range "2018 - 2022" or single year "2022"
    if (fact.year) {
      const yearStr = String(fact.year);
      const matches = Array.from(yearStr.matchAll(/\b(19\d{2}|20\d{2})\b/g)).map((m) => parseInt(m[1], 10));
      if (matches.length >= 2) {
        if (explicitStartYear === null) explicitStartYear = matches[0];
        if (explicitEndYear === null) explicitEndYear = matches[1];
      } else if (matches.length === 1) {
        if (explicitEndYear === null) explicitEndYear = matches[0];
      }
    }

    // Months
    if (explicitStartMonth === null) {
      explicitStartMonth =
        parseMonthName(fact.start_month) ??
        parseMonthName(fact.startMonth) ??
        parseMonthName(fact.fromMonth) ??
        parseMonthName(fact.startDate) ??
        null;
    }

    if (explicitEndMonth === null) {
      explicitEndMonth =
        parseMonthName(fact.end_month) ??
        parseMonthName(fact.endMonth) ??
        parseMonthName(fact.graduation_month) ??
        parseMonthName(fact.graduationMonth) ??
        parseMonthName(fact.toMonth) ??
        parseMonthName(fact.endDate) ??
        parseMonthName(fact.graduationDate) ??
        null;
    }

    if (explicitEndYear !== null || explicitStartYear !== null) {
      hasAnyYear = true;
      break;
    }
  }

  // Without any proven graduation or attendance year, never fabricate dates
  if (!hasAnyYear) {
    return null;
  }

  const endYear = explicitEndYear ?? (explicitStartYear ? (isMasters ? explicitStartYear + 2 : explicitStartYear + 4) : null);
  if (!endYear) return null;

  const startYear =
    explicitStartYear ??
    (isMasters ? endYear - 2 : endYear - 4);

  switch (subfieldType) {
    case 'start_year': {
      const val = alignYearOption(String(startYear), options);
      return {
        value: val,
        confidence: explicitStartYear !== null ? 0.95 : 0.9,
      };
    }
    case 'end_year': {
      const val = alignYearOption(String(endYear), options);
      return {
        value: val,
        confidence: 0.95,
      };
    }
    case 'start_month': {
      const monthName = explicitStartMonth || 'September';
      const val = alignMonthOption(monthName, options);
      return {
        value: val,
        confidence: explicitStartMonth ? 0.95 : 0.85,
      };
    }
    case 'end_month': {
      const monthName = explicitEndMonth || 'May';
      const val = alignMonthOption(monthName, options);
      return {
        value: val,
        confidence: explicitEndMonth ? 0.95 : 0.85,
      };
    }
    default:
      return null;
  }
}

/**
 * Alias for extractEducationDateSubfield supporting (label, resumeFacts) signature.
 */
export function extractEducationDateSubfields(label: string, resumeFacts?: any): EducationDateResult | null {
  return extractEducationDateSubfield(label, undefined, undefined, resumeFacts);
}

export default extractEducationDateSubfield;
