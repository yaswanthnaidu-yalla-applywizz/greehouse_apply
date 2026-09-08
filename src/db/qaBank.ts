/**
 * @fileoverview Database operations for candidate question-and-answer bank (V2).
 * Table: `candidate_qa_bank`
 */

import { getDbClient } from './client.js';

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
  const supabase = getDbClient();

  const { data, error } = await supabase
    .from('candidate_qa_bank')
    .select('*')
    .eq('applywizz_id', applywizzId)
    .eq('question_fingerprint', questionFingerprint)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Failed to get QA answer for candidate ${applywizzId} [fp: ${questionFingerprint}]: ${error.message}`
    );
  }

  return data as QABankRow | null;
}

/**
 * Upserts a QA answer into the candidate QA bank.
 * Keyed by unique constraint (applywizz_id, question_fingerprint).
 */
export async function upsertAnswer(entry: QABankRow): Promise<void> {
  const supabase = getDbClient();
  const payload = {
    ...entry,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('candidate_qa_bank')
    .upsert(payload, { onConflict: 'applywizz_id,question_fingerprint' });

  if (error) {
    throw new Error(
      `Failed to upsert QA answer for candidate ${entry.applywizz_id} [fp: ${entry.question_fingerprint}]: ${error.message}`
    );
  }
}

/**
 * Retrieves all stored QA answers for a candidate.
 */
export async function findAnswersByCandidate(applywizzId: string): Promise<QABankRow[]> {
  const supabase = getDbClient();

  const { data, error } = await supabase
    .from('candidate_qa_bank')
    .select('*')
    .eq('applywizz_id', applywizzId)
    .order('updated_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to find QA answers for candidate ${applywizzId}: ${error.message}`);
  }

  return (data || []) as QABankRow[];
}

export const findAnswerByFingerprint = getAnswer;
