import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  detectCsvFormat,
  parseCsvJobRow,
  segregateCandidatesByApplyWizzId,
} from '../src/candidate/segregator.js';
import {
  upsertApplication,
  getApplicationByTaskId,
} from '../src/db/applications.js';

describe('Task ID Ingestion & Upsert (TDD)', () => {
  describe('CSV Parsing with task_id', () => {
    it('detects format and parses task_id from incoming CSV row format', () => {
      const headers = ['task_id', 'company_name', 'job_url', 'score', 'lead_name', 'applywizz_id'];
      const format = detectCsvFormat(headers);
      assert.notEqual(format, 'UNKNOWN');

      const row = {
        task_id: 'cdcb66ce-3184-4419-9ab3-c0f75992f223',
        company_name: 'NISC',
        job_url: 'https://grnh.se/l9wc1a1q1us',
        score: '91.0',
        lead_name: 'Vinay Kumar',
        applywizz_id: 'AWL-6307',
      };

      const parsed = parseCsvJobRow(row, format);
      assert.ok(parsed);
      assert.equal(parsed?.applywizzId, 'AWL-6307');
      assert.equal(parsed?.rawUrl, 'https://grnh.se/l9wc1a1q1us');
      assert.equal(parsed?.score, 91.0);
      assert.equal(parsed?.taskId, 'cdcb66ce-3184-4419-9ab3-c0f75992f223');
    });

    it('parses taskId case-insensitively from Task ID or task_id aliases', () => {
      const row = {
        'Task ID': 'test-uuid-alias-1234',
        'Applywizz ID': 'AWL-11111',
        'Client Name': 'Alice Test',
        'url': 'https://boards.greenhouse.io/testco/jobs/12345',
        'score': '85',
      };

      const parsed = parseCsvJobRow(row, 'OLD');
      assert.ok(parsed);
      assert.equal(parsed?.taskId, 'test-uuid-alias-1234');
    });

    it('populates taskId onto jobs in candidate segments from CSV', async () => {
      const csvDir = await mkdtemp(path.join(os.tmpdir(), 'task-id-ingestion-'));
      const csvPath = path.join(csvDir, 'jobs.csv');
      await writeFile(
        csvPath,
        'task_id,company_job_url,score,lead_name,applywizz_id\n' +
          'cdcb66ce-3184-4419-9ab3-c0f75992f223,https://boards.greenhouse.io/nisc/jobs/123,91.0,Vinay Kumar,AWL-6307\n'
      );

      try {
        const segments = await segregateCandidatesByApplyWizzId(csvPath, {
          syncProfiles: false,
          downloadResumes: false,
          allowOutboundApi: false,
        });

        const segment = segments.get('AWL-6307');
        assert.ok(segment);
        assert.equal(segment.jobs.length, 1);
        assert.equal(segment.jobs[0].taskId, 'cdcb66ce-3184-4419-9ab3-c0f75992f223');
      } finally {
        await rm(csvDir, { recursive: true, force: true });
      }
    });
  });

  describe('upsertApplication with task_id', () => {
    it('persists task_id and allows retrieval via getApplicationByTaskId', async () => {
      const testTaskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const testJobUrl = `https://boards.greenhouse.io/tdd-co/jobs/${Date.now()}`;

      const saved = await upsertApplication({
        task_id: testTaskId,
        applywizz_id: 'AWL-TDD-001',
        job_url: testJobUrl,
        resolved_fields: [{ fieldId: 'first_name', name: 'first_name', type: 'text', label: 'First Name', value: 'Test', source: 'supabase', resolvedByTier: 1, confidence: 1.0 }],
        status: 'READY_FOR_REVIEW',
      });

      assert.ok(saved);
      assert.equal(saved.task_id, testTaskId);

      const retrieved = await getApplicationByTaskId(testTaskId);
      assert.ok(retrieved);
      assert.equal(retrieved?.applywizz_id, 'AWL-TDD-001');
      assert.equal(retrieved?.task_id, testTaskId);
    });

    it('allows two distinct application records for the same candidate and job URL when task_ids differ', async () => {
      const sharedCandidate = 'AWL-TDD-MULTI';
      const sharedJobUrl = `https://boards.greenhouse.io/tdd-multi/jobs/${Date.now()}`;
      const taskId1 = `task-1-${Date.now()}`;
      const taskId2 = `task-2-${Date.now()}`;

      const app1 = await upsertApplication({
        task_id: taskId1,
        applywizz_id: sharedCandidate,
        job_url: sharedJobUrl,
        resolved_fields: [],
        status: 'READY_FOR_REVIEW',
      });

      const app2 = await upsertApplication({
        task_id: taskId2,
        applywizz_id: sharedCandidate,
        job_url: sharedJobUrl,
        resolved_fields: [],
        status: 'READY_FOR_REVIEW',
      });

      assert.ok(app1);
      assert.ok(app2);
      assert.notEqual(app1.id, app2.id, 'Both applications must have distinct row IDs');
      assert.equal(app1.task_id, taskId1);
      assert.equal(app2.task_id, taskId2);
    });

    it('updates existing row in-place when upserting with the same task_id (idempotency)', async () => {
      const taskId = `task-idem-${Date.now()}`;
      const jobUrl = `https://boards.greenhouse.io/tdd-idem/jobs/${Date.now()}`;

      const initial = await upsertApplication({
        task_id: taskId,
        applywizz_id: 'AWL-IDEM',
        job_url: jobUrl,
        resolved_fields: [],
        status: 'READY_FOR_REVIEW',
      });

      const updated = await upsertApplication({
        task_id: taskId,
        applywizz_id: 'AWL-IDEM',
        job_url: jobUrl,
        resolved_fields: [{ fieldId: 'f1', name: 'f1', type: 'text', label: 'Field 1', value: 'Updated', source: 'manual', resolvedByTier: null, confidence: 1.0 }],
        status: 'READY_FOR_REVIEW',
      });

      assert.equal(initial.id, updated.id, 'Idempotent upsert on task_id must update the same row');
      assert.equal(updated.resolved_fields.length, 1);
    });
  });
});
