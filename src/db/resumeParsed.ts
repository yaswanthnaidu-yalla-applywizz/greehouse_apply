/**
 * @fileoverview Database operations for candidate parsed resume cache (V2).
 * Table: `candidate_resume_parsed`
 */

import { getDbClient } from './client.js';

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
 * Retrieves the cached parsed resume for a candidate by ApplyWizz ID.
 */
export async function getParsedResume(applywizzId: string): Promise<ResumeParsedRow | null> {
  const supabase = getDbClient();

  const { data, error } = await supabase
    .from('candidate_resume_parsed')
    .select('*')
    .eq('applywizz_id', applywizzId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to get parsed resume for candidate ${applywizzId}: ${error.message}`);
  }

  return data as ResumeParsedRow | null;
}

/**
 * Upserts a parsed resume record into the cache.
 * Keyed by unique constraint (applywizz_id).
 */
export async function upsertParsedResume(record: ResumeParsedRow): Promise<ResumeParsedRow> {
  const supabase = getDbClient();
  const payload = {
    ...record,
    parsed_at: record.parsed_at || new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('candidate_resume_parsed')
    .upsert(payload, { onConflict: 'applywizz_id' })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to upsert parsed resume for candidate ${record.applywizz_id}: ${error.message}`);
  }

  return data as ResumeParsedRow;
}
