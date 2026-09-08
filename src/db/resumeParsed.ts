/**
 * @fileoverview Database operations for candidate parsed resume cache (V2).
 * Table: `candidate_resume_parsed`
 */

import fs from 'fs';
import path from 'path';
import { getDbClient, isSupabaseConfigured } from './client.js';

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

/**
 * Retrieves the cached parsed resume for a candidate by ApplyWizz ID from Supabase or local cache.
 */
export async function getParsedResume(applywizzId: string): Promise<ResumeParsedRow | null> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('candidate_resume_parsed')
        .select('*')
        .eq('applywizz_id', applywizzId)
        .maybeSingle();

      if (!error && data) {
        return data as ResumeParsedRow;
      }
    } catch (err: any) {
      // Fall through to local fallback
    }
  }

  // Local JSON fallback
  const localPath = path.resolve(process.cwd(), 'cache', 'parsed_resumes', `${applywizzId}.json`);
  if (fs.existsSync(localPath)) {
    try {
      return JSON.parse(fs.readFileSync(localPath, 'utf-8'));
    } catch {}
  }

  return null;
}

/**
 * Upserts a parsed resume record into the Supabase cache or local cache.
 * Keyed by unique constraint (applywizz_id).
 */
export async function upsertParsedResume(record: ResumeParsedRow): Promise<ResumeParsedRow> {
  const payload = {
    ...record,
    parsed_at: record.parsed_at || new Date().toISOString(),
  };

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('candidate_resume_parsed')
        .upsert(payload, { onConflict: 'applywizz_id' })
        .select()
        .single();

      if (!error && data) {
        return data as ResumeParsedRow;
      }
    } catch (err: any) {
      // Fall through to local fallback
    }
  }

  // Local JSON fallback
  try {
    const dir = path.resolve(process.cwd(), 'cache', 'parsed_resumes');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const localPath = path.join(dir, `${record.applywizz_id}.json`);
    fs.writeFileSync(localPath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {}

  return payload as ResumeParsedRow;
}

