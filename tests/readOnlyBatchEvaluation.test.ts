import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Client } from 'pg';
import type { ProfileRow } from '../src/db/profiles.js';
import { AnswerResolver, mergeTier5ResolvedField } from '../src/resolver/answerResolver.js';
import { resolveIngestTier5, type IngestTier5Work } from '../src/resolver/ingestTier5Coordinator.js';
import { generateFingerprint } from '../src/resolver/fingerprint.js';
import {
  createReadOnlyTier5FieldKey,
  runReadOnlyBatchEvaluation,
  reconcileReadOnlyFunnel,
  cachedResumeFromProfile,
  createReadOnlyProductionScannerAdapter,
  isReadOnlyEvaluationCandidateEligible,
  isReadOnlyTier5Field,
  openPostgresReadOnlyEvidenceSession,
  READ_ONLY_SEMANTIC_RPC_PREFLIGHT_SQL,
  writeReadOnlyEvaluationOutput,
  type ReadOnlyBatchEvaluationPorts,
  type ReadOnlyEvidenceSession,
} from '../src/resolver/readOnlyBatchEvaluation.js';
import type { ScannedField, ScannedJobTemplate } from '../src/types/index.js';

describe('read-only batch evaluation boundary', () => {
  it('keeps duplicate task assignments distinct through Tier 5 collection and result mapping', async () => {
    const field = { fieldId: 'f1', name: 'f1', type: 'text', label: 'Do you have experience with Python?', isRequired: true } as any;
    const makeWork = (assignmentOrdinal: number): IngestTier5Work => ({
      candidateId: 'AWL-DUP-TASK', jobUrl: 'https://example.test/job', taskId: 'same-task', assignmentOrdinal,
      fieldKey: createReadOnlyTier5FieldKey({ candidateId: 'AWL-DUP-TASK', jobUrl: 'https://example.test/job', taskId: 'same-task', assignmentOrdinal, field, slotIndex: 0 }),
      field, original: { ...field, value: '', source: 'unresolved', resolvedByTier: null, confidence: 0 } as any,
      profile: {} as ProfileRow, resumeText: '', jobTitle: 'Role', companyName: 'Example', questionFingerprint: generateFingerprint(field.label, field.type),
    });
    const first = makeWork(3);
    const second = makeWork(4);
    assert.notEqual(first.fieldKey, second.fieldKey);

    const resolved = await resolveIngestTier5([first, second], {
      async haiku(items) {
        return items.map((item) => ({ fieldKey: item.fieldKey, answer: {
          ...field, value: item === first ? 'Python' : 'Python and pytest', source: 'ai', resolvedByTier: 5, confidence: 0.9,
        } as any }));
      },
      async sonnet() { return []; },
    });
    assert.equal(resolved.get(first.fieldKey)?.value, 'Python');
    assert.equal(resolved.get(second.fieldKey)?.value, 'Python and pytest');
  });

  it('reconciles creation by task identity and keeps unsupported outcomes unknown', () => {
    const assignments = [
      { applywizzId: 'AWL-1', jobUrl: 'job-a', taskId: 'new-task', assignmentOrdinal: 0, output: 'resolved' as const, hasResolvedFields: true, filtered: false, needsReview: false },
      { applywizzId: 'AWL-1', jobUrl: 'job-a', taskId: 'existing-task', assignmentOrdinal: 1, output: 'resolved' as const, hasResolvedFields: true, filtered: false, needsReview: false },
      { applywizzId: 'AWL-1', jobUrl: 'job-b', taskId: 'expired-task', assignmentOrdinal: 2, output: 'expired' as const, hasResolvedFields: false, filtered: false, needsReview: false },
      { applywizzId: 'AWL-1', jobUrl: 'job-c', taskId: 'missing-task', assignmentOrdinal: 3, output: 'missing' as const, hasResolvedFields: false, filtered: false, needsReview: false },
      { applywizzId: 'AWL-1', jobUrl: 'job-d', taskId: 'unresolved-task', assignmentOrdinal: 4, output: 'resolved' as const, hasResolvedFields: true, filtered: false, needsReview: true },
    ];
    const result = reconcileReadOnlyFunnel(assignments, [
      { applywizz_id: 'AWL-1', job_url: 'job-a', task_id: 'existing-task' },
      { applywizz_id: 'AWL-1', job_url: 'job-a', task_id: 'prior-task' },
      { applywizz_id: 'AWL-1', job_url: 'job-b', task_id: 'expired-task' },
    ], true);
    assert.deepEqual(result.dispositions.map(({ disposition }) => disposition), [
      'created_auto_queue_eligible', 'existing_task_updated', 'expired', 'missing_output', 'created_review',
    ]);
    assert.equal(result.createdDenominator, 2, 'new task counts as a creation even when the candidate/job pair already exists');
    assert.equal(result.counts.existing_pair_updated, 0, 'task-id assignments do not fall back to pair matching');
    assert.equal(result.actualQueued, null, 'the read-only snapshot does not prove queue events');
    assert.equal(reconcileReadOnlyFunnel([assignments[0]!], undefined).dispositions[0]?.disposition, 'unknown_creation');
  });

  it('keeps task creation unknown without global ID coverage and flags duplicate incoming task IDs', () => {
    const assignment = {
      applywizzId: 'AWL-1', jobUrl: 'job-a', taskId: 'new-task', assignmentOrdinal: 0,
      output: 'resolved' as const, hasResolvedFields: true, filtered: false, needsReview: false,
    };
    const pairScopedSnapshot = [{ applywizz_id: 'AWL-1', job_url: 'job-a', task_id: 'unrelated-task' }];
    assert.equal(reconcileReadOnlyFunnel([assignment], pairScopedSnapshot).dispositions[0]?.disposition, 'unknown_creation');
    assert.equal(reconcileReadOnlyFunnel([assignment], pairScopedSnapshot, true).dispositions[0]?.disposition, 'created_auto_queue_eligible');

    const duplicate = { ...assignment, assignmentOrdinal: 1, jobUrl: 'job-b' };
    const result = reconcileReadOnlyFunnel([assignment, duplicate], [], true);
    assert.deepEqual(result.dispositions.map(({ disposition }) => disposition), ['unknown_creation', 'unknown_creation']);
    assert.equal(result.createdDenominator, 0, 'duplicate globally unique IDs cannot inflate the creation denominator');
  });

  it('shares production Tier 5 choice and corporate-policy finalization', () => {
    const smsField: ScannedField = {
      fieldId: 'sms_consent', name: 'sms_consent', type: 'select',
      label: 'Do you consent to receive text messages about your application?',
      isRequired: true, options: ['Yes', 'No'],
    };
    const aiAnswer = {
      ...smsField, value: 'Yes', source: 'ai' as const, resolvedByTier: 5, confidence: 0.95,
    };
    const finalized = mergeTier5ResolvedField(smsField, aiAnswer);
    assert.equal(finalized.value, 'No');
    assert.equal(finalized.source, 'supabase');
    assert.equal(finalized.resolvedByTier, 1);
    assert.equal(finalized.confidence, 1);

    const optionalField = { ...smsField, isRequired: false };
    assert.equal(mergeTier5ResolvedField(optionalField, aiAnswer).value, 'No', 'optional Tier 5 answers follow the same production corporate-policy clamp');
  });

  it('rejects a real mutation in a local PostgreSQL read-only transaction', { skip: !process.env.BATCH_EVAL_LOCAL_TEST_DATABASE_URL }, async () => {
    const connectionString = process.env.BATCH_EVAL_LOCAL_TEST_DATABASE_URL!;
    const target = new URL(connectionString);
    assert.ok(['127.0.0.1', 'localhost', '::1'].includes(target.hostname), 'integration test only permits loopback PostgreSQL');
    assert.equal(decodeURIComponent(target.pathname.slice(1)), 'applywizz_sandbox', 'integration test only permits the local sandbox database');

    const client = new Client({ connectionString, connectionTimeoutMillis: 2000 });
    await client.connect();
    try {
      const identity = await client.query<{ db: string }>('SELECT current_database() AS db');
      assert.equal(identity.rows[0]?.db, 'applywizz_sandbox');
      await client.query('BEGIN READ ONLY');
      const mode = await client.query<{ transaction_read_only: string }>('SHOW transaction_read_only');
      assert.equal(mode.rows[0]?.transaction_read_only, 'on');
      await assert.rejects(
        client.query('CREATE TEMP TABLE read_only_boundary_probe (id integer)'),
        /read-only transaction/i,
      );
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  });

  it('keeps the production evaluation entry point outside queue, notification, storage, and resume-parser integrations', async () => {
    const source = await fs.readFile(new URL('../src/resolver/readOnlyBatchEvaluation.ts', import.meta.url), 'utf8');
    const importStatements = [...source.matchAll(/^import\b[^;]*;/gm)].map((match) => match[0]);
    const imports = importStatements.map((statement) => statement.match(/\bfrom ['"](.+?)['"]/ )?.[1]).filter(Boolean);
    const runtimeImports = importStatements
      .filter((statement) => !/^import\s+type\b/.test(statement))
      .map((statement) => statement.match(/\bfrom ['"](.+?)['"]/ )?.[1])
      .filter(Boolean);
    assert.ok(imports.includes('./answerResolver.js'));
    assert.ok(imports.includes('../orchestrator/pipeline.js'));
    assert.ok(!imports.some((specifier) => /queue|notification|storage/i.test(specifier)));
    assert.ok(!runtimeImports.some((specifier) => /tier2ResumeParse/i.test(specifier)));
    assert.ok(!/flushPendingAutoQueue|send.*Email|ingestCsvFromStorage|exportScannedJobs|getOrParseResume/.test(source));
  });

  it('reuses production CSV parsing, URL deduplication, scanner output, and answer resolution', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-eval-'));
    const csvPath = path.join(tempDirectory, 'jobs.csv');
    const outputPath = path.join(tempDirectory, 'results', 'evaluation.json');
    const jobUrl = 'https://boards.greenhouse.io/example/jobs/123';
    await fs.writeFile(
      csvPath,
      [
        'Applywizz ID,Client Name,url,score',
        `AWL-EVAL-1,Sample Candidate,${jobUrl}?utm_source=one,45`,
        `AWL-EVAL-1,Sample Candidate,${jobUrl}?utm_source=two,45`,
      ].join('\n'),
      'utf8',
    );

    let opened = false;
    let closed = false;
    let scannedUrls: string[] = [];
    let semanticCalls = 0;
    const session: ReadOnlyEvidenceSession = {
      async readCandidateEvidence(applywizzId) {
        assert.equal(applywizzId, 'AWL-EVAL-1');
        return {
          profile: { applywizz_id: applywizzId, zoho_connected: true } as ProfileRow,
          parsedResume: null,
          qaEntries: [{ id: 'qa-manual-1', applywizz_id: applywizzId, question_fingerprint: 'stored-fingerprint', question_label: 'Past reviewed SQL answer', field_type: 'text', value: 'PostgreSQL in production', source: 'manual', confidence: 1, updated_at: '2026-11-12T00:00:00Z' }],
        };
      },
      semanticSearchAdapters: {
        async embedTexts(texts) {
          assert.ok(texts.length > 0);
          return texts.map(() => [1, 0]);
        },
        async matchCandidateQa(args) {
          semanticCalls++;
          assert.equal(args.matchApplywizzId, 'AWL-EVAL-1');
          return {
            data: [{
        question_label: 'Which SQL database have you used most in production?',
        value: 'PostgreSQL',
              similarity: 0.99,
            }],
          };
        },
      },
      async readExistingApplications() { return []; },
      async readBaselineApplications(fromUtc, toUtc) {
        assert.equal(fromUtc, '2026-11-10T18:30:00.000Z');
        assert.equal(toUtc, '2026-11-11T18:30:00.000Z');
        return [1, 2].map(() => ({
          applywizz_id: 'AWL-EVAL-1',
          job_url: 'https://boards.greenhouse.io/example/jobs/123',
          created_at: '2026-11-11T12:00:00.000Z',
          resolved_fields: [{ label: 'Which SQL database have you used most in production?', type: 'text', value: 'PostgreSQL' }],
        }));
      },
      async close() { closed = true; },
    };
    const template: ScannedJobTemplate = {
      jobUrl,
      companyName: 'Example Co',
      jobTitle: 'Platform Engineer',
      scannedAt: new Date(0).toISOString(),
      isExpired: false,
      fields: [{
        fieldId: 'current_title',
        name: 'current_title',
        type: 'text',
        label: 'Which SQL database have you used most in production?',
        isRequired: true,
      }],
    };
    const ports: ReadOnlyBatchEvaluationPorts = {
      async openReadOnlyEvidenceSession() {
        opened = true;
        return session;
      },
      async resolveShortlinksBatch(urls) {
        return new Map(urls.map((url) => [url, url]));
      },
      async scanUrls(urls) {
        scannedUrls = urls;
        return { templates: [template], errors: [] };
      },
    };

    try {
      const result = await runReadOnlyBatchEvaluation(csvPath, ports, outputPath);
      assert.equal(opened, true);
      assert.equal(closed, true);
      assert.deepEqual(scannedUrls, [jobUrl]);
      assert.deepEqual(result.uniqueUrls, [jobUrl]);
      assert.equal(result.candidateCount, 1);
      assert.equal(result.applications.length, 1);
      assert.equal(result.applications[0].resolvedFields[0].source, 'semantic');
      assert.equal(result.applications[0].answerAudit.length, result.applications[0].resolvedFields.length);
      assert.equal(result.applications[0].answerAudit[0].sourceTier, 3);
      assert.equal(result.applications[0].answerAudit[0].reviewerVerdict, 'unreviewed');
      assert.deepEqual(result.applications[0].reviewEvidence[0].qaEntries, [], 'field evidence must not repeat unrelated candidate QA');
      assert.equal(result.candidateQaInventory.length, 1);
      assert.equal(result.candidateQaInventory[0].qaEntries[0].id, 'qa-manual-1');
      assert.equal(result.candidateQaInventory[0].qaEntries[0].source, 'manual');
      assert.equal(result.candidateQaInventory[0].qaEntries[0].value, 'PostgreSQL in production');
      assert.equal(result.metrics?.createdApplicationDenominator, 1);
      assert.equal(result.metrics?.wouldAutoQueueEligible, 1);
      assert.equal(result.metrics?.answerOutcomes.resolved, 1);
      assert.ok(result.metrics?.totalDurationMs !== undefined);
      assert.ok(result.metrics?.phaseDurationMs.csv_deduplication !== undefined);
      assert.equal(result.metrics?.baseline.matchedPairs, 1);
      assert.equal(result.metrics?.baseline.duplicatePairs[0]?.count, 2);
      assert.equal(result.metrics?.baseline.duplicatePairs[0]?.allCreatedAt.length, 2);
      assert.equal(result.metrics?.baseline.duplicatePairs[0]?.selectedLatestCreatedAt, '2026-11-11T12:00:00.000Z');
      assert.equal(result.metrics?.baseline.answerChanges[0]?.outcome, 'unknown_legacy_identity', 'duplicate candidate/job baselines without task IDs cannot select a latest comparison row');
      assert.deepEqual(JSON.parse(await fs.readFile(outputPath, 'utf8')), result);
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it('keeps task assignments and repeated field slots distinct when legacy comparison identity is ambiguous', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-eval-task-slots-'));
    const csvPath = path.join(tempDirectory, 'jobs.csv');
    const jobUrl = 'https://boards.greenhouse.io/example/jobs/task-slots';
    await fs.writeFile(csvPath, [
      'Applywizz ID,Client Name,url,score,task_id',
      `AWL-SLOTS,Sample Candidate,${jobUrl},45,`,
      `AWL-SLOTS,Sample Candidate,${jobUrl},45,task-a`,
      `AWL-SLOTS,Sample Candidate,${jobUrl},45,task-b`,
    ].join('\n'));
    const repeatedLabel = 'Do you have this experience?';
    try {
      const result = await runReadOnlyBatchEvaluation(csvPath, {
        ingestRunId: 'run-task-slots',
        async openReadOnlyEvidenceSession() {
          return {
            async readCandidateEvidence(id) { return { profile: { applywizz_id: id, zoho_connected: true } as ProfileRow, parsedResume: null, qaEntries: [] }; },
            async readBaselineApplications() { return [{
              applywizz_id: 'AWL-SLOTS', job_url: jobUrl, task_id: 'task-a',
              resolved_fields: [
                { label: 'A different historical question', type: 'text', value: 'legacy one', fieldId: 'experience_a', slotIndex: 0 },
                { label: repeatedLabel, type: 'text', value: 'legacy two' },
              ],
            }]; },
            semanticSearchAdapters: { async embedTexts(texts) { return texts.map(() => [1]); }, async matchCandidateQa() { return { data: [] }; } },
            async close() {},
          };
        },
        async resolveShortlinksBatch(urls) { return new Map(urls.map((url) => [url, url])); },
        async scanUrls() { return { templates: [{
          jobUrl, companyName: 'Example', jobTitle: 'Role', scannedAt: new Date(0).toISOString(), isExpired: false,
          fields: [
            { fieldId: 'experience_a', name: 'experience_a', type: 'text', label: repeatedLabel, isRequired: false },
            { fieldId: 'experience_b', name: 'experience_b', type: 'text', label: repeatedLabel, isRequired: false },
          ],
        }], errors: [] }; },
      });
      assert.equal(result.applications.length, 3);
      assert.deepEqual(result.applications.map((application) => application.taskId), [null, 'task-a', 'task-b']);
      assert.deepEqual(result.applications.map((application) => application.assignmentOrdinal), [0, 1, 2]);
      assert.equal(result.metrics?.answerOutcomes.unresolved, 6);
      assert.equal(result.metrics?.baseline.answerChanges.length, 6);
      assert.ok(result.metrics?.baseline.answerChanges.every((change) => change.outcome === 'unknown_legacy_identity'));
      assert.ok(result.metrics?.baseline.answerChanges.every((change) => change.ingestRunId === 'run-task-slots'));
      assert.equal(new Set(result.metrics?.baseline.answerChanges.map((change) => `${change.taskId}:${change.assignmentOrdinal}:${change.fieldId}:${change.slotIndex}`)).size, 6);
      assert.equal(result.metrics?.baseline.removedHistoricalAnswers.length, 2);
      assert.deepEqual(result.metrics?.baseline.removedHistoricalAnswers.map((answer) => answer.slotIndex), [0, 1]);
      assert.deepEqual(result.metrics?.baseline.removedHistoricalAnswers.map((answer) => answer.outcome), ['removed', 'unknown_legacy_identity']);
      assert.ok(result.metrics?.baseline.removedHistoricalAnswers.every((answer) => answer.ingestRunId === 'run-task-slots'));
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it('writes slot-level Tier 5 evidence decisions as unreviewed private audit data', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-eval-answer-audit-'));
    const csvPath = path.join(tempDirectory, 'jobs.csv');
    const outputPath = path.join(tempDirectory, 'private', 'evaluation.json');
    const jobUrl = 'https://boards.greenhouse.io/example/jobs/answer-audit';
    await fs.writeFile(csvPath, `Applywizz ID,Client Name,url,score,task_id\nAWL-AUDIT,Sample Candidate,${jobUrl},45,task-audit\n`);
    const fields = [
      { fieldId: 'question-a', name: 'question-a', type: 'textarea', label: 'Why do you want to join our team?', isRequired: true, options: ['PostgreSQL', 'MySQL'], optionsComplete: true },
      { fieldId: 'question-b', name: 'question-b', type: 'textarea', label: 'Why do you want to join our team?', isRequired: true },
    ];
    try {
      const result = await runReadOnlyBatchEvaluation(csvPath, {
        ingestRunId: 'audit-run',
        async openReadOnlyEvidenceSession() {
          return {
            async readCandidateEvidence(id) { return { profile: { applywizz_id: id, zoho_connected: true } as ProfileRow, parsedResume: null, qaEntries: [] }; },
            semanticSearchAdapters: { async embedTexts(texts) { return texts.map(() => [1]); }, async matchCandidateQa() { return { data: [] }; } },
            async close() {},
          };
        },
        async resolveShortlinksBatch(urls) { return new Map(urls.map((url) => [url, url])); },
        async scanUrls() { return { templates: [{ jobUrl, companyName: 'Example', jobTitle: 'Role', scannedAt: new Date(0).toISOString(), isExpired: false, fields }], errors: [] }; },
        createTier5Stages() {
          return {
            async haiku(items) {
              const first = items[0];
              return [{ fieldKey: first.fieldKey, answer: { fieldId: first.field.fieldId, name: first.field.name, type: first.field.type, label: first.field.label, value: 'PostgreSQL', source: 'ai', resolvedByTier: 5, confidence: 0.9 }, evaluation: {
                fieldKey: first.fieldKey, stage: 'haiku', outcome: 'rejected', reason: 'review_required', supportQuote: 'I am excited to contribute', evidenceReference: 'sha256:0123456789abcdef',
              } }];
            },
            async sonnet() { return []; },
          };
        },
      }, outputPath);

      const audit = result.applications[0].answerAudit;
      assert.equal(audit.length, 2, JSON.stringify(result.applications[0].resolvedFields));
      assert.deepEqual(audit.map((record) => [record.taskId, record.fieldId, record.slotIndex]), [
        ['task-audit', 'question-a', 0], ['task-audit', 'question-b', 1],
      ]);
      assert.deepEqual(audit.map((record) => record.answerDecision), ['unresolved', 'unresolved']);
      assert.deepEqual(audit.map((record) => record.reviewerVerdict), ['unreviewed', 'unreviewed']);
      assert.equal(audit[0].stageDecisions[0].supportQuote, 'I am excited to contribute');
      assert.equal(audit[0].stageDecisions[0].evidenceReference, 'sha256:0123456789abcdef');
      assert.equal(audit[1].stageDecisions[0].outcome, 'missing');
      assert.equal(audit[1].stageDecisions[0].supportQuote, undefined);
      assert.deepEqual(audit[0].options, ['PostgreSQL', 'MySQL']);
      assert.equal(audit[0].optionsComplete, true);
      assert.deepEqual(JSON.parse(await fs.readFile(outputPath, 'utf8')).applications[0].answerAudit, audit);
      if (process.platform !== 'win32') assert.equal((await fs.stat(outputPath)).mode & 0o777, 0o600);
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it('refuses to write into a nonprivate existing artifact directory', { skip: process.platform === 'win32' }, async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-eval-privacy-'));
    const outputDirectory = path.join(tempDirectory, 'shared');
    const outputPath = path.join(outputDirectory, 'evaluation.json');
    await fs.mkdir(outputDirectory, { mode: 0o755 });
    try {
      await assert.rejects(writeReadOnlyEvaluationOutput(outputPath, {} as any), /existing artifact directory is not private/i);
      await assert.rejects(fs.access(outputPath), { code: 'ENOENT' });
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it('does not scan if a read-only evidence session cannot be opened', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-eval-gate-'));
    const csvPath = path.join(tempDirectory, 'jobs.csv');
    await fs.writeFile(csvPath, 'Applywizz ID,Client Name,url,score\nAWL-1,Test,https://boards.greenhouse.io/a/jobs/1,45\n');
    let scanCalled = false;

    try {
      await assert.rejects(
        runReadOnlyBatchEvaluation(csvPath, {
          async openReadOnlyEvidenceSession() { throw new Error('read-only connection unavailable'); },
          async resolveShortlinksBatch() { return new Map(); },
          async scanUrls() { scanCalled = true; return { templates: [], errors: [] }; },
        }),
        /read-only connection unavailable/,
      );
      assert.equal(scanCalled, false);
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it('reports candidates without profiles as excluded to match production segregation', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-eval-missing-profile-'));
    const csvPath = path.join(tempDirectory, 'jobs.csv');
    const jobUrl = 'https://boards.greenhouse.io/example/jobs/789';
    await fs.writeFile(csvPath, [
      'Applywizz ID,Client Name,url,score',
      `AWL-MISSING,Missing Profile,${jobUrl},45`,
      `AWL-PRESENT,Present Profile,${jobUrl},45`,
    ].join('\n'));
    try {
      const result = await runReadOnlyBatchEvaluation(csvPath, {
        async openReadOnlyEvidenceSession() {
          return {
            async readCandidateEvidence(applywizzId) {
              return {
                profile: applywizzId === 'AWL-MISSING' ? null : { applywizz_id: applywizzId, zoho_connected: true } as ProfileRow,
                parsedResume: null,
                qaEntries: [],
              };
            },
            semanticSearchAdapters: {
              async embedTexts(texts) { return texts.map(() => [1, 0]); },
              async matchCandidateQa() { return { data: [] }; },
            },
            async close() {},
          };
        },
        async resolveShortlinksBatch(urls) { return new Map(urls.map((url) => [url, url])); },
        async scanUrls() {
          return { templates: [{ jobUrl, companyName: 'Example', jobTitle: 'Role', scannedAt: new Date(0).toISOString(), isExpired: false, fields: [] }], errors: [] };
        },
      });
      assert.equal(result.candidateCount, 2);
      assert.equal(result.eligibleCandidateCount, 1);
      assert.deepEqual(result.excludedCandidates, [{
        applywizzId: 'AWL-MISSING',
        reason: 'profile_missing (production segregator excludes candidates without a profile)',
      }]);
      assert.equal(result.applications.length, 1);
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it('rejects evaluation without every evidence and semantic adapter before resolving fields', async () => {
    await assert.rejects(
      new AnswerResolver().resolveFormFields(
        'AWL-1',
        [{ fieldId: 'f', name: 'f', type: 'text', label: 'Required field', isRequired: true }],
        { companyName: 'Example', jobTitle: 'Role' },
        { profile: null, parsedResume: null, qaEntries: [] },
        { mode: 'evaluation' },
      ),
      /requires explicit profile, cached resume, QA, exact-answer, and semantic-search adapters/,
    );
  });

  it('keeps candidate CSV deduplication and production shortlink alignment in the runtime path', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-eval-shortlink-'));
    const csvPath = path.join(tempDirectory, 'jobs.csv');
    const shortUrl = 'https://grnh.se/example';
    const jobUrl = 'https://boards.greenhouse.io/example/jobs/123';
    await fs.writeFile(csvPath, [
      'Applywizz ID,Client Name,url,score',
      `AWL-EVAL-2,Sample Candidate,${shortUrl},45`,
      `AWL-EVAL-2,Sample Candidate,${shortUrl},44`,
    ].join('\n'));
    let reads = 0;
    let scans: string[] = [];
    try {
      const result = await runReadOnlyBatchEvaluation(csvPath, {
        async openReadOnlyEvidenceSession() {
          return {
            async readCandidateEvidence() {
              reads++;
              return { profile: { applywizz_id: 'AWL-EVAL-2', zoho_connected: true } as ProfileRow, parsedResume: null, qaEntries: [] };
            },
            semanticSearchAdapters: {
              async embedTexts(texts) { return texts.map(() => [1, 0]); },
              async matchCandidateQa() { return { data: [] }; },
            },
            async close() {},
          };
        },
        async resolveShortlinksBatch(urls) {
          assert.deepEqual(urls, [shortUrl]);
          return new Map([[shortUrl, jobUrl]]);
        },
        async scanUrls(urls) {
          scans = urls;
          return { templates: [{ jobUrl, companyName: 'Example', jobTitle: 'Role', scannedAt: new Date(0).toISOString(), isExpired: false, fields: [] }], errors: [] };
        },
      });
      assert.deepEqual(scans, [jobUrl]);
      assert.deepEqual(result.uniqueUrls, [jobUrl]);
      assert.equal(result.candidateCount, 1);
      assert.equal(result.applications.length, 1);
      assert.equal(reads, 1);
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it('uses the persisted parsed-resume cache as Tier 2 evidence without parsing', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-eval-resume-'));
    const csvPath = path.join(tempDirectory, 'jobs.csv');
    const jobUrl = 'https://boards.greenhouse.io/example/jobs/456';
    await fs.writeFile(csvPath, [
      'Applywizz ID,Client Name,url,score',
      `AWL-RESUME-EVAL,Sample Candidate,${jobUrl},45`,
    ].join('\n'));
    const profile = {
      applywizz_id: 'AWL-RESUME-EVAL',
      client_name: 'Sample Candidate',
      zoho_connected: true,
      resume_text: 'Cached resume text',
      resume_facts: { skills: ['Rust', 'Postgres'], experience: [], education: [], rawSections: {} },
    } as ProfileRow;
    const parsedResume = cachedResumeFromProfile('AWL-RESUME-EVAL', profile);
    assert.ok(parsedResume);

    try {
      const result = await runReadOnlyBatchEvaluation(csvPath, {
        async openReadOnlyEvidenceSession() {
          return {
            async readCandidateEvidence() {
              return { profile, parsedResume, qaEntries: [] };
            },
            semanticSearchAdapters: {
              async embedTexts() { throw new Error('Tier 3 should not run after Tier 2 hit.'); },
              async matchCandidateQa() { throw new Error('Tier 3 should not run after Tier 2 hit.'); },
            },
            async close() {},
          };
        },
        async resolveShortlinksBatch(urls) { return new Map(urls.map((url) => [url, url])); },
        async scanUrls() {
          return { templates: [{
            jobUrl,
            companyName: 'Example',
            jobTitle: 'Role',
            scannedAt: new Date(0).toISOString(),
            isExpired: false,
            fields: [{ fieldId: 'technical_skills', name: 'technical_skills', type: 'textarea', label: 'Technical Skills', isRequired: true }],
          }], errors: [] };
        },
      });
      assert.equal(result.applications[0].resolvedFields[0].value, 'Rust, Postgres');
      assert.equal(result.applications[0].resolvedFields[0].source, 'resume_parse');
      assert.equal(result.applications[0].resolvedFields[0].resolvedByTier, 2);
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it('keeps optional resume attachment work aligned with production attachment obligations', () => {
    const unresolved = { source: 'unresolved', isRequired: false };
    assert.equal(isReadOnlyTier5Field({ fieldId: 'resume_upload', name: 'resume_upload', type: 'file', label: 'Resume', isRequired: false }, unresolved), true);
    assert.equal(isReadOnlyTier5Field({ fieldId: 'optional_note', name: 'optional_note', type: 'text', label: 'Optional note', isRequired: false }, unresolved), false);
  });

  it('returns pending Haiku and Sonnet outcomes without writing a finalized evaluation', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-eval-pending-'));
    const csvPath = path.join(tempDirectory, 'jobs.csv');
    const outputPath = path.join(tempDirectory, 'private', 'final.json');
    const jobUrl = 'https://boards.greenhouse.io/example/jobs/pending';
    await fs.writeFile(csvPath, `Applywizz ID,Client Name,url,score\nAWL-PENDING,Sample Candidate,${jobUrl},45\n`);
    const template: ScannedJobTemplate = {
      jobUrl, companyName: 'Example', jobTitle: 'Role', scannedAt: new Date(0).toISOString(), isExpired: false,
      fields: [{ fieldId: 'motivation', name: 'motivation', type: 'textarea', label: 'Why do you want to join our team?', isRequired: true }],
    };
    try {
      for (const pendingStage of ['haiku', 'sonnet'] as const) {
        const result = await runReadOnlyBatchEvaluation(csvPath, {
          async openReadOnlyEvidenceSession() {
            return {
              async readCandidateEvidence(applywizzId) { return { profile: { applywizz_id: applywizzId, zoho_connected: true } as ProfileRow, parsedResume: null, qaEntries: [] }; },
              semanticSearchAdapters: { async embedTexts(texts) { return texts.map(() => [1]); }, async matchCandidateQa() { return { data: [] }; } },
              async close() {},
            };
          },
          async resolveShortlinksBatch(urls) { return new Map(urls.map((url) => [url, url])); },
          async scanUrls() { return { templates: [template], errors: [] }; },
          createTier5Stages() {
            return {
              async haiku(items) {
                if (pendingStage === 'haiku') return { results: [], pending: true, batchIds: ['known-haiku'] };
                return items.map((item) => ({ fieldKey: item.fieldKey, answer: { fieldId: 'motivation', name: 'motivation', type: 'textarea', label: 'Why do you want to join our team?', value: 'I am excited to contribute to this team.', source: 'ai', resolvedByTier: 5, confidence: 0.9 } }));
              },
              async sonnet() { return { results: [], pending: true, batchIds: ['known-sonnet'] }; },
            };
          },
        }, outputPath);
        assert.equal(result.status, 'pending');
        assert.equal(result.pendingBatch?.stage, pendingStage);
        assert.deepEqual(result.pendingBatch?.batchIds, [pendingStage === 'haiku' ? 'known-haiku' : 'known-sonnet']);
        await assert.rejects(fs.access(outputPath), { code: 'ENOENT' });
      }
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it('routes local URLs through the production scanner and reports navigation failures', async () => {
    const scanUrls = createReadOnlyProductionScannerAdapter();
    const scanned = await scanUrls(['http://127.0.0.1:1/jobs/readonly-eval']);
    assert.equal(scanned.templates.length, 1);
    assert.equal(scanned.templates[0].isExpired, true);
    assert.ok(scanned.errors.some((error) => error.url.includes('127.0.0.1')));
  });

  it('routes an Ashby fixture through the production scanner adapter', async () => {
    const fixture = await fs.readFile(new URL('./fixtures/ashby-required-optional.html', import.meta.url), 'utf8');
    const server = (await import('node:http')).default.createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(fixture);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const jobUrl = `http://127.0.0.1:${address.port}/example/job?ashby_jid=fixture`;
      const scanned = await createReadOnlyProductionScannerAdapter()([jobUrl]);
      assert.deepEqual(scanned.errors, []);
      assert.equal(scanned.templates.length, 1);
      assert.equal(scanned.templates[0].jobUrl, jobUrl);
      assert.equal(scanned.templates[0].fields.length, 2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports every eligible candidate/job whose scan template is missing', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-eval-scan-missing-'));
    const csvPath = path.join(tempDirectory, 'jobs.csv');
    const jobUrl = 'https://boards.greenhouse.io/example/jobs/999';
    await fs.writeFile(csvPath, `Applywizz ID,Client Name,url,score\nAWL-SCAN,Example,${jobUrl},45\n`);
    try {
      const result = await runReadOnlyBatchEvaluation(csvPath, {
        async openReadOnlyEvidenceSession() {
          return {
            async readCandidateEvidence() { return { profile: { applywizz_id: 'AWL-SCAN', zoho_connected: true } as ProfileRow, parsedResume: null, qaEntries: [] }; },
            semanticSearchAdapters: { async embedTexts(texts) { return texts.map(() => [1]); }, async matchCandidateQa() { return { data: [] }; } },
            async close() {},
          };
        },
        async resolveShortlinksBatch(urls) { return new Map(urls.map((url) => [url, url])); },
        async scanUrls() { return { templates: [], errors: [{ url: jobUrl, message: 'navigation failed' }] }; },
      });
      assert.deepEqual(result.excludedJobs, [{ applywizzId: 'AWL-SCAN', jobUrl, reason: 'scan_failed: navigation failed' }]);
      assert.equal(result.applications.length, 0);
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it('checks the public RPC signature with the extensions.vector type and explicit EXECUTE privilege', () => {
    assert.match(READ_ONLY_SEMANTIC_RPC_PREFLIGHT_SQL, /public\.match_candidate_qa\(extensions\.vector,text,double precision,integer\)/);
    assert.match(READ_ONLY_SEMANTIC_RPC_PREFLIGHT_SQL, /has_function_privilege\(current_user/);
  });

  it('verifies BEGIN READ ONLY on the evidence session and rolls it back on close', async () => {
    const queries: string[] = [];
    let released = false;
    let ended = false;
    let readOnlyTransaction = false;
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql === 'BEGIN READ ONLY') readOnlyTransaction = true;
        if (readOnlyTransaction && /^(UPDATE|INSERT|DELETE|CREATE|ALTER|DROP)\b/i.test(sql.trim())) {
          throw new Error('cannot execute write in a read-only transaction');
        }
        if (sql === 'SHOW transaction_read_only') return { rows: [{ transaction_read_only: 'on' }] };
        if (sql === READ_ONLY_SEMANTIC_RPC_PREFLIGHT_SQL) return { rows: [{ function_exists: true, can_execute: true }] };
        return { rows: [] };
      },
      release() { released = true; },
    };
    const session = await openPostgresReadOnlyEvidenceSession({
      databaseUrl: 'postgres://read-only-test',
      embedTexts: async (texts) => texts.map(() => [1]),
      poolFactory: () => ({ async connect() { return client as never; }, async end() { ended = true; } }),
    });
    await session.readCandidateEvidence('AWL-READONLY');
    await assert.rejects(
      (client.query as (sql: string) => Promise<unknown>)('UPDATE profiles SET client_name = $1 WHERE applywizz_id = $2'),
      /cannot execute write in a read-only transaction/,
    );
    await session.close();
    assert.equal(queries[0], 'BEGIN READ ONLY');
    assert.ok(queries.some((sql) => sql.startsWith('UPDATE profiles')));
    assert.ok(queries.includes('SHOW transaction_read_only'));
    assert.ok(queries.includes('ROLLBACK'));
    assert.equal(released, true);
    assert.equal(ended, true);
  });

  it('rolls back and closes the session when semantic RPC preflight fails', async () => {
    const queries: string[] = [];
    let released = false;
    let ended = false;
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql === 'SHOW transaction_read_only') return { rows: [{ transaction_read_only: 'on' }] };
        if (sql === READ_ONLY_SEMANTIC_RPC_PREFLIGHT_SQL) return { rows: [{ function_exists: true, can_execute: false }] };
        return { rows: [] };
      },
      release() { released = true; },
    };
    await assert.rejects(openPostgresReadOnlyEvidenceSession({
      databaseUrl: 'postgres://read-only-test',
      embedTexts: async (texts) => texts.map(() => [1]),
      poolFactory: () => ({ async connect() { return client as never; }, async end() { ended = true; } }),
    }), /requires EXECUTE/);
    assert.equal(queries[0], 'BEGIN READ ONLY');
    assert.ok(queries.includes('ROLLBACK'));
    assert.equal(released, true);
    assert.equal(ended, true);
  });

  it('applies the production Zoho eligibility gate before resolution', async () => {
    assert.equal(isReadOnlyEvaluationCandidateEligible({ applywizz_id: 'AWL-EVAL-3', zoho_connected: false } as ProfileRow, true), false);
    assert.equal(isReadOnlyEvaluationCandidateEligible({ applywizz_id: 'AWL-EVAL-3', zoho_connected: true } as ProfileRow, true), true);
    assert.equal(isReadOnlyEvaluationCandidateEligible(null, false), true);
  });

});
