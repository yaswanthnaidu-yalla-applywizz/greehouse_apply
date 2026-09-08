/**
 * @fileoverview Persistent Candidate Q&A Bank for Knowledge Persistence.
 *
 * Saves newly answered questions per candidate so that recurring custom questions
 * across multiple job postings reuse previously resolved/verified answers.
 *
 * References:
 * - 02-trd.md (Section 3.4)
 * - 05-backend-schema.md (Section 1.4)
 */

import fs from 'fs';
import path from 'path';
import type { ResolvedField, SourceTag } from '../types/index.js';

/**
 * Key-value mapping of normalized question keys to resolved answers.
 */
export interface CandidateQARecord {
  questionLabel: string;
  fieldId: string;
  fieldType: string;
  value: string;
  source: SourceTag;
  confidence: number;
  savedAt: string;
}

/**
 * QABank manages persistent Q&A storage per candidate in `./cache/qa_bank/`.
 */
export class QABank {
  private readonly storageDir: string;
  private readonly memoryCache = new Map<string, Map<string, CandidateQARecord>>();

  /**
   * Initializes the Q&A bank storage directory.
   *
   * @param storageDir - Directory where candidate Q&A JSON files are saved.
   */
  constructor(storageDir: string = './cache/qa_bank') {
    this.storageDir = path.resolve(process.cwd(), storageDir);
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  /**
   * Generates a normalized question key from label and fieldId.
   *
   * @param label - Question label.
   * @param fieldId - Field identifier.
   * @returns Normalized cache key.
   */
  private normalizeKey(label: string, fieldId: string): string {
    const text = label || fieldId;
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').trim();
  }

  /**
   * Loads the candidate's Q&A store from disk into memory.
   *
   * @param applywizzId - Candidate identifier.
   * @returns Map of question key to CandidateQARecord.
   */
  private loadCandidateStore(applywizzId: string): Map<string, CandidateQARecord> {
    if (this.memoryCache.has(applywizzId)) {
      return this.memoryCache.get(applywizzId)!;
    }

    const filePath = path.join(this.storageDir, `${applywizzId}_qa.json`);
    const store = new Map<string, CandidateQARecord>();

    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed: Record<string, CandidateQARecord> = JSON.parse(raw);
        for (const [k, v] of Object.entries(parsed)) {
          store.set(k, v);
        }
      } catch (err: any) {
        console.warn(`[Q&A Bank] ⚠️ Failed to load Q&A cache for ${applywizzId}: ${err.message}`);
      }
    }

    this.memoryCache.set(applywizzId, store);
    return store;
  }

  /**
   * Retrieves a previously answered question for a candidate.
   *
   * @param applywizzId - Candidate identifier.
   * @param label - Question label.
   * @param fieldId - Field identifier.
   * @returns ResolvedField if previously stored, or null.
   */
  public getAnswer(
    applywizzId: string,
    label: string,
    fieldId: string
  ): ResolvedField | null {
    const store = this.loadCandidateStore(applywizzId);
    const key = this.normalizeKey(label, fieldId);

    if (store.has(key)) {
      const record = store.get(key)!;
      return {
        fieldId,
        name: fieldId,
        type: record.fieldType,
        label,
        value: record.value,
        source: record.source,
        resolvedByTier: 1,
        confidence: record.confidence,
      };
    }

    return null;
  }

  /**
   * Saves or updates an answered question in the candidate's persistent Q&A bank.
   *
   * @param applywizzId - Candidate identifier.
   * @param field - The resolved field.
   */
  public saveAnswer(applywizzId: string, field: ResolvedField): void {
    const store = this.loadCandidateStore(applywizzId);
    const key = this.normalizeKey(field.label, field.fieldId);

    store.set(key, {
      questionLabel: field.label,
      fieldId: field.fieldId,
      fieldType: field.type,
      value: field.value,
      source: field.source,
      confidence: field.confidence,
      savedAt: new Date().toISOString(),
    });

    // Write to disk synchronously to avoid concurrent write race conditions
    const filePath = path.join(this.storageDir, `${applywizzId}_qa.json`);
    const obj: Record<string, CandidateQARecord> = {};
    for (const [k, v] of store.entries()) {
      obj[k] = v;
    }

    try {
      fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err: any) {
      console.warn(`[Q&A Bank] ⚠️ Failed to save Q&A cache for ${applywizzId}: ${err.message}`);
    }
  }
}
