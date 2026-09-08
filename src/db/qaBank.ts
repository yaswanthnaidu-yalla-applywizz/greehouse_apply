/**
 * @fileoverview Database operations for candidate question-and-answer bank (V2).
 * Table: `candidate_qa_bank`
 */

import fs from 'fs';
import path from 'path';
import { getDbClient, isSupabaseConfigured } from './client.js';

export interface QABankRow {
  id?: string;
  applywizz_id: string;
  question_fingerprint: string;
  question_label: string;
  field_type: string;
  value: string;
  source: 'ai' | 'manual';
  confidence?: number;
  created_at?: string;
  updated_at?: string;
}

/**
 * Retrieves a single cached QA answer by candidate ApplyWizz ID and question fingerprint.
 */
export async function getAnswer(
  applywizzId: string,
  questionFingerprint: string
): Promise<QABankRow | null> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('candidate_qa_bank')
        .select('*')
        .eq('applywizz_id', applywizzId)
        .eq('question_fingerprint', questionFingerprint)
        .maybeSingle();

      if (!error && data) {
        return data as QABankRow;
      }
    } catch (err: any) {
      // Fall through to local fallback
    }
  }

  // Local JSON fallback (cache/qa_bank/{applywizzId}.json)
  const localPath = path.resolve(process.cwd(), 'cache', 'qa_bank', `${applywizzId}.json`);
  if (fs.existsSync(localPath)) {
    try {
      const answers = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
      if (Array.isArray(answers)) {
        const found = answers.find(
          (a) =>
            a.question_fingerprint === questionFingerprint ||
            (a as any).questionFingerprint === questionFingerprint
        );
        if (found) return found as QABankRow;
      }
    } catch {}
  }

  return null;
}

/**
 * Upserts a QA answer into the candidate QA bank.
 * Keyed by unique constraint (applywizz_id, question_fingerprint).
 */
export async function upsertAnswer(entry: QABankRow): Promise<void> {
  const payload = {
    ...entry,
    updated_at: new Date().toISOString(),
  };

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      await supabase
        .from('candidate_qa_bank')
        .upsert(payload, { onConflict: 'applywizz_id,question_fingerprint' });
      return;
    } catch (err: any) {
      // Fall through to local fallback
    }
  }

  // Local JSON fallback
  try {
    const qaDir = path.resolve(process.cwd(), 'cache', 'qa_bank');
    if (!fs.existsSync(qaDir)) {
      fs.mkdirSync(qaDir, { recursive: true });
    }
    const localPath = path.join(qaDir, `${entry.applywizz_id}.json`);
    let list: QABankRow[] = [];
    if (fs.existsSync(localPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
        if (Array.isArray(parsed)) list = parsed;
      } catch {}
    }
    const idx = list.findIndex((x) => x.question_fingerprint === entry.question_fingerprint);
    if (idx >= 0) {
      list[idx] = payload;
    } else {
      list.push(payload);
    }
    fs.writeFileSync(localPath, JSON.stringify(list, null, 2), 'utf-8');
  } catch {}
}

/**
 * Retrieves all stored QA answers for a candidate.
 */
export async function findAnswersByCandidate(applywizzId: string): Promise<QABankRow[]> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('candidate_qa_bank')
        .select('*')
        .eq('applywizz_id', applywizzId)
        .order('updated_at', { ascending: false });

      if (!error && data && data.length > 0) {
        return data as QABankRow[];
      }
    } catch (err: any) {
      // Fall through to local fallback
    }
  }

  // Local JSON fallback
  const localPath = path.resolve(process.cwd(), 'cache', 'qa_bank', `${applywizzId}.json`);
  if (fs.existsSync(localPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
      if (Array.isArray(data)) return data as QABankRow[];
    } catch {}
  }

  return [];
}


export const findAnswerByFingerprint = getAnswer;

