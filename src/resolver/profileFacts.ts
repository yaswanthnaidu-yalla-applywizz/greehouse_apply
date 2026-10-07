import type { ProfileRow } from '../db/profiles.js';
import { normalizeText } from './fingerprint.js';

export interface ProfileFact {
  label: string;
  value: string;
}

const EXCLUDED_PROFILE_KEYS = new Set([
  'id',
  'applywizz_id',
  'created_at',
  'updated_at',
  'last_api_fetch_at',
  'resume_storage_path',
  'resume_url',
  'resume_text',
]);

function humanizePath(path: string): string {
  return path
    .replace(/\[\d+\]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFacts(value: unknown, prefix = '', depth = 0): ProfileFact[] {
  if (depth > 6 || value === null || value === undefined) return [];

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value).trim();
    return prefix && text ? [{ label: humanizePath(prefix), value: text }] : [];
  }

  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((item) =>
      typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
    )) {
      const text = value.map((item) => String(item).trim()).filter(Boolean).join(', ');
      return prefix && text ? [{ label: humanizePath(prefix), value: text }] : [];
    }
    return value.slice(0, 10).flatMap((item, index) =>
      extractFacts(item, `${prefix}[${index}]`, depth + 1)
    );
  }

  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) =>
      extractFacts(child, prefix ? `${prefix}.${key}` : key, depth + 1)
    );
  }

  return [];
}

export function getProfileFacts(profile?: ProfileRow | null): ProfileFact[] {
  if (!profile) return [];

  const facts = Object.entries(profile)
    .filter(([key]) => key !== 'raw_api_payload' && !EXCLUDED_PROFILE_KEYS.has(key))
    .flatMap(([key, value]) => extractFacts(value, key));
  facts.push(...extractFacts(profile.raw_api_payload, ''));

  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = `${normalizeText(fact.label)}|${fact.value}`;
    if (!fact.label || !fact.value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
