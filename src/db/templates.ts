/**
 * @fileoverview Database operations for scanned Greenhouse job templates (V2).
 * Table: `scanned_job_templates`
 */

import { getDbClient } from './client.js';
import type { ScannedField } from '../types/index.js';

export interface TemplateRow {
  id?: string;
  job_url: string;
  company_name?: string | null;
  job_title?: string | null;
  fields_schema: ScannedField[];
  field_count?: number;
  is_expired?: boolean;
  scanned_at?: string;
  updated_at?: string;
}

/**
 * Upserts a scanned Greenhouse job template record into Supabase.
 * Keyed on unique job_url.
 */
export async function upsertTemplate(
  template: Partial<TemplateRow> & { job_url: string; fields_schema: ScannedField[] }
): Promise<TemplateRow> {
  const supabase = getDbClient();
  const payload = {
    ...template,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('scanned_job_templates')
    .upsert(payload, { onConflict: 'job_url' })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to upsert job template for ${template.job_url}: ${error.message}`);
  }

  return data as TemplateRow;
}

/**
 * Retrieves a scanned job template by its Greenhouse job URL.
 */
export async function getTemplateByUrl(jobUrl: string): Promise<TemplateRow | null> {
  const supabase = getDbClient();

  const { data, error } = await supabase
    .from('scanned_job_templates')
    .select('*')
    .eq('job_url', jobUrl)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to get template for URL ${jobUrl}: ${error.message}`);
  }

  return data as TemplateRow | null;
}

/**
 * Lists all scanned job templates from Supabase.
 */
export async function listTemplates(): Promise<TemplateRow[]> {
  const supabase = getDbClient();

  const { data, error } = await supabase
    .from('scanned_job_templates')
    .select('*')
    .order('scanned_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to list job templates: ${error.message}`);
  }

  return (data || []) as TemplateRow[];
}
