/**
 * @fileoverview Database operations for scanned Greenhouse job templates (V2).
 * Table: `scanned_job_templates`
 */

import fs from 'fs';
import path from 'path';
import { getDbClient, isSupabaseConfigured } from './client.js';
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
 * Upserts a scanned Greenhouse job template record into Supabase or local cache.
 * Keyed on unique job_url.
 */
export async function upsertTemplate(
  template: Partial<TemplateRow> & { job_url: string; fields_schema: ScannedField[] }
): Promise<TemplateRow> {
  const payload = {
    ...template,
    updated_at: new Date().toISOString(),
  };

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('gh_scanned_job_templates')
        .upsert(payload, { onConflict: 'job_url' })
        .select()
        .single();

      if (!error && data) {
        return data as TemplateRow;
      }
    } catch (err: any) {
      // Fall through to local fallback
    }
  }

  return payload as TemplateRow;
}

/**
 * Retrieves a scanned job template by its Greenhouse job URL from Supabase or local cache.
 */
export async function getTemplateByUrl(jobUrl: string): Promise<TemplateRow | null> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('gh_scanned_job_templates')
        .select('*')
        .eq('job_url', jobUrl)
        .maybeSingle();

      if (!error && data) {
        return data as TemplateRow;
      }
    } catch (err: any) {
      // Fall through to local fallback
    }
  }

  // Local JSON fallback (output/scanned_jobs.json)
  const scannedPath = path.resolve(process.cwd(), 'output', 'scanned_jobs.json');
  if (fs.existsSync(scannedPath)) {
    try {
      const list: any[] = JSON.parse(fs.readFileSync(scannedPath, 'utf-8'));
      if (Array.isArray(list)) {
        const found = list.find((t) => t.jobUrl === jobUrl || t.job_url === jobUrl);
        if (found) {
          return {
            job_url: found.jobUrl || found.job_url,
            company_name: found.companyName || found.company_name,
            job_title: found.jobTitle || found.job_title,
            fields_schema: found.fields || found.fields_schema || [],
            is_expired: Boolean(found.isExpired || found.is_expired),
          };
        }
      }
    } catch {}
  }

  return null;
}

/**
 * Lists all scanned job templates from Supabase or local cache.
 */
export async function listTemplates(): Promise<TemplateRow[]> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('gh_scanned_job_templates')
        .select('*')
        .order('scanned_at', { ascending: false });

      if (!error && data) {
        return (data || []) as TemplateRow[];
      }
    } catch (err: any) {
      // Fall through to local fallback
    }
  }

  // Local JSON fallback
  const scannedPath = path.resolve(process.cwd(), 'output', 'scanned_jobs.json');
  if (fs.existsSync(scannedPath)) {
    try {
      const list: any[] = JSON.parse(fs.readFileSync(scannedPath, 'utf-8'));
      if (Array.isArray(list)) {
        return list.map((found) => ({
          job_url: found.jobUrl || found.job_url,
          company_name: found.companyName || found.company_name,
          job_title: found.jobTitle || found.job_title,
          fields_schema: found.fields || found.fields_schema || [],
          is_expired: Boolean(found.isExpired || found.is_expired),
        }));
      }
    } catch {}
  }

  return [];
}

function collectJobUrlVariants(jobUrl: string): string[] {
  const urls: string[] = [];
  const raw = (jobUrl || '').trim();
  if (!raw) return urls;
  urls.push(raw);
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) urls.push(decoded);
  } catch {
    /* ignore */
  }
  return urls;
}

function urlsLooselyMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}

/**
 * Finds a scanned template for a job URL (exact match, then substring match across all templates).
 */
export async function findTemplateByJobUrl(jobUrl: string): Promise<TemplateRow | null> {
  for (const variant of collectJobUrlVariants(jobUrl)) {
    const exact = await getTemplateByUrl(variant);
    if (exact && Array.isArray(exact.fields_schema) && exact.fields_schema.length > 0) {
      return exact;
    }
  }

  const variants = collectJobUrlVariants(jobUrl);
  const all = await listTemplates();
  for (const row of all) {
    if (!row.job_url || !Array.isArray(row.fields_schema) || row.fields_schema.length === 0) {
      continue;
    }
    if (variants.some((v) => urlsLooselyMatch(v, row.job_url))) {
      return row;
    }
  }

  return null;
}

