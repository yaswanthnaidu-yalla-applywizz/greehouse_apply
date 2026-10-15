import type { ApplyWizzCandidateProfile } from '../types/index.js';

type ExclusionReason = 'excluded_company' | 'latest_employer';

function normalizeCompanyName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function excludedCompanies(profile: ApplyWizzCandidateProfile): string[] {
  const raw = profile.raw_api_payload?.additional_information?.exclude_companies;
  let values: unknown;
  if (Array.isArray(raw)) {
    values = raw;
  } else if (typeof raw === 'string') {
    try {
      values = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => typeof value === 'string'
    ? value.split(',').map((name) => name.trim()).filter(Boolean)
    : []);
}

function parseDate(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (/^present$/i.test(text)) return Number.POSITIVE_INFINITY;

  const yearMonth = text.match(/^(\d{4})[-/](\d{1,2})$/);
  if (yearMonth) return Date.UTC(Number(yearMonth[1]), Number(yearMonth[2]) - 1);
  const monthYear = text.match(/^(\d{1,2})\/(\d{4})$/);
  if (monthYear) return Date.UTC(Number(monthYear[2]), Number(monthYear[1]) - 1);
  const year = text.match(/^(19|20)\d{2}$/);
  if (year) return Date.UTC(Number(text), 0);

  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function experienceEndDate(experience: Record<string, unknown>): number | null {
  const explicit = parseDate(experience.endDate ?? experience.end_date);
  if (explicit !== null) return explicit;
  if (typeof experience.duration !== 'string') return null;
  const range = experience.duration.match(/(?:^|[-–—])\s*(present|(?:19|20)\d{2}(?:[-/]\d{1,2})?|(?:0?[1-9]|1[0-2])\/(?:19|20)\d{2}|[A-Za-z]{3,9}\s+(?:19|20)\d{2})\s*$/i);
  return range ? parseDate(range[1]) : null;
}

function latestResumeEmployer(profile: ApplyWizzCandidateProfile): string | null {
  const facts = profile.resumeFacts;
  if (!facts || typeof facts !== 'object' || !Array.isArray((facts as Record<string, unknown>).experience)) {
    return null;
  }
  let latest: { company: string; endDate: number } | null = null;
  for (const item of (facts as { experience: unknown[] }).experience) {
    if (!item || typeof item !== 'object') continue;
    const experience = item as Record<string, unknown>;
    const company = typeof experience.company === 'string' ? experience.company.trim() : '';
    const endDate = experienceEndDate(experience);
    if (!company || endDate === null) continue;
    if (!latest || endDate > latest.endDate) latest = { company, endDate };
  }
  return latest?.company ?? null;
}

export function getApplicationExclusionReasons(
  profile: ApplyWizzCandidateProfile | undefined,
  companyName: string
): ExclusionReason[] {
  if (!profile) return [];
  const company = normalizeCompanyName(companyName);
  if (!company) return [];

  const reasons: ExclusionReason[] = [];
  if (excludedCompanies(profile).some((excluded) => normalizeCompanyName(excluded) === company)) {
    reasons.push('excluded_company');
  }
  const employer = latestResumeEmployer(profile);
  if (employer && normalizeCompanyName(employer) === company) {
    reasons.push('latest_employer');
  }
  return reasons;
}
