import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { decodeSnapshotEmbedding, mergeExistingApplicationSnapshots, parseArgs, parseShortlinkMap, readCsvShortlinks, resolveMappedShortlinks, validateResumeManifest } from '../scripts/run-readonly-batch-evaluation.js';
import { readAndDeduplicateUrls } from '../src/scanner/csvDeduplicator.js';
import { alignAndFilterCandidateSegmentJobs } from '../src/orchestrator/pipeline.js';
import type { CandidateSegment } from '../src/types/index.js';

describe('read-only batch evaluation CLI arguments', () => {
  const required = ['--csv', 'jobs.csv', '--evidence-snapshot', 'evidence.json', '--run-dir', '.ai/diagnostics/read-only-batch-evaluation/run-1'];

  it('accepts standalone --resume with all required path options', () => {
    const parsed = parseArgs([...required, '--resume']);
    assert.equal(parsed.resume, true);
    assert.equal(parsed.csvPath.endsWith('jobs.csv'), true);
    assert.equal(parsed.snapshotPath.endsWith('evidence.json'), true);
    assert.equal(parsed.runDirectory.endsWith('run-1'), true);
  });

  it('keeps resume optional', () => {
    assert.equal(parseArgs(required).resume, false);
  });

  it('accepts a local shortlink map path', () => {
    assert.equal(parseArgs([...required, '--shortlink-map', 'map.json']).shortlinkMapPath?.endsWith('map.json'), true);
  });

  it('rejects missing values, unknown or positional arguments, and duplicates', () => {
    for (const argv of [
      ['--csv'],
      [...required, '--unknown'],
      [...required, 'stray'],
      [...required, '--resume=true'],
      [...required, '--resume', '--resume'],
      [...required, '--csv', 'second.csv'],
    ]) assert.throws(() => parseArgs(argv));
  });
});

describe('read-only batch evaluation resume manifest', () => {
  const hashes = { csvSha256: 'csv-hash', snapshotSha256: 'snapshot-hash' };

  it('allows resume only when both input hashes match the prior run manifest', () => {
    assert.doesNotThrow(() => validateResumeManifest(hashes, hashes, true));
    assert.throws(() => validateResumeManifest({ ...hashes, csvSha256: 'different' }, hashes, true), /hash differs/);
    assert.throws(() => validateResumeManifest({ ...hashes, snapshotSha256: 'different' }, hashes, true), /hash differs/);
  });

  it('pins the shortlink map content hash on resume', () => {
    const withMap = { ...hashes, shortlinkMapSha256: 'map-hash' };
    assert.doesNotThrow(() => validateResumeManifest(withMap, withMap, true));
    assert.throws(() => validateResumeManifest(withMap, { ...withMap, shortlinkMapSha256: 'changed-map' }, true), /shortlink map hash differs/);
    assert.throws(() => validateResumeManifest(withMap, hashes, true), /shortlink map hash differs/);
  });

  it('requires --resume for an existing manifest and a manifest for --resume', () => {
    assert.throws(() => validateResumeManifest(hashes, hashes, false), /pass --resume/);
    assert.throws(() => validateResumeManifest(undefined, hashes, true), /requires an existing run manifest/);
    assert.doesNotThrow(() => validateResumeManifest(undefined, hashes, false));
  });
});

describe('existing application snapshot merge', () => {
  it('deduplicates exact repeated rows while preserving contradictory rows that share a task ID', () => {
    const first = { applywizz_id: 'AWL-1', job_url: 'https://example.com/a', task_id: 'task-1', status: 'READY_FOR_REVIEW' };
    const conflicting = { applywizz_id: 'AWL-2', job_url: 'https://example.com/b', task_id: 'task-1', status: 'APPLIED' };
    assert.deepEqual(mergeExistingApplicationSnapshots([first, first, conflicting]), [first, conflicting]);
  });
});

describe('snapshot QA embedding decoding', () => {
  const pgvector = (...values: number[]) => {
    const bytes = Buffer.alloc(4 + values.length * 4);
    bytes.writeInt16BE(values.length, 0);
    bytes.writeInt16BE(0, 2);
    values.forEach((value, index) => bytes.writeFloatBE(value, 4 + index * 4));
    return bytes.toString('base64');
  };

  it('decodes pgvector binary float32 values and preserves legacy array/text forms', () => {
    const binary = decodeSnapshotEmbedding(undefined, pgvector(1, 0, -1), 3)!;
    const legacy = decodeSnapshotEmbedding('[1, 0, -1]', undefined, 3)!;
    assert.deepEqual(binary, [1, 0, -1]);
    assert.ok(Math.abs(cosineForTest(binary, legacy) - 1) < 1e-12);
    assert.deepEqual(decodeSnapshotEmbedding([1, 0, -1], undefined, 3), legacy);
    assert.equal(decodeSnapshotEmbedding(null, null, 3), null);
  });

  it('rejects malformed headers, dimension mismatches, and non-finite components', () => {
    const malformed = Buffer.from(pgvector(1, 2, 3), 'base64');
    malformed.writeInt16BE(2, 0);
    assert.throws(() => decodeSnapshotEmbedding(undefined, malformed.toString('base64'), 3), /header or dimension/);
    assert.throws(() => decodeSnapshotEmbedding([1, 2], undefined, 3), /dimension mismatch/);
    assert.throws(() => decodeSnapshotEmbedding([1, Number.NaN, 3], undefined, 3), /non-finite/);
    assert.throws(() => decodeSnapshotEmbedding(undefined, 'not base64!', 3), /base64/);
  });
});

function cosineForTest(a: number[], b: number[]): number {
  const dot = a.reduce((sum, value, index) => sum + value * b[index]!, 0);
  const normA = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
  const normB = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0));
  return dot / (normA * normB);
}

describe('offline shortlink mapping through production URL paths', () => {
  const source = 'https://grnh.se/fake-token';
  const target = 'https://boards.greenhouse.io/fake/jobs/123';

  it('validates fake mappings against scanner routing and normalization, including supported custom routes', () => {
    assert.deepEqual([...parseShortlinkMap(JSON.stringify([[source, target]]))], [[source, target]]);
    for (const supported of [
      'https://job-boards.greenhouse.io/company/jobs/123',
      'https://boards.greenhouse.io/company/jobs/123',
      'https://app.greenhouse.io/embed/job_app?token=123',
      'https://careers.example.com/jobs/123?gh_jid=123',
    ]) assert.equal(parseShortlinkMap(JSON.stringify([[source, supported]])).get(source), supported);
    assert.throws(() => parseShortlinkMap(JSON.stringify([[source, 'https://jobs.ashbyhq.com/company/job']])) , /Greenhouse scanner routes/);
    assert.throws(() => parseShortlinkMap(JSON.stringify([[source, 'https://user:pass@careers.example.com/jobs/123']])), /without credentials/);
    assert.throws(() => parseShortlinkMap(JSON.stringify([[source, target], [source, target]])), /unique normalized/);
  });

  it('requires CSV mappings before the evaluation can open its evidence session', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-shortlinks-required-'));
    const csvPath = path.join(directory, 'fake.csv');
    try {
      await fs.writeFile(csvPath, `url\n${source}\nhttps://boards.greenhouse.io/company/jobs/123\n`);
      assert.deepEqual(await readCsvShortlinks(csvPath), [source]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('reports only missing and unchanged counts for large map gaps', () => {
    const urls = Array.from({ length: 252 }, (_, index) => `https://grnh.se/token-${index}`);
    const mapping = new Map(urls.slice(0, 251).map((url) => [url, url === urls[0] ? url : `https://boards.greenhouse.io/company/jobs/${url.split('-').at(-1)}`]));
    assert.throws(() => resolveMappedShortlinks(urls, mapping), (error: unknown) => {
      assert.equal((error as Error).message, 'Shortlink mappings require correction: missing=1, unchanged=1.');
      assert.equal((error as Error).message.includes('token-'), false);
      return true;
    });
  });

  it('deduplicates and aligns via the supplied map without network access', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-shortlinks-'));
    const csvPath = path.join(directory, 'fake.csv');
    try {
      await fs.writeFile(csvPath, `url\n${source}\n${source}\n`);
      const mapping = parseShortlinkMap(JSON.stringify([[source, target]]));
      let resolved = new Map<string, string>();
      const unique = await readAndDeduplicateUrls(csvPath, {
        resolveShortlinksBatch: async (urls) => (resolved = resolveMappedShortlinks(urls, mapping)),
      });
      assert.deepEqual(unique, [target]);
      const segment: CandidateSegment = {
        applywizzId: 'FAKE-CANDIDATE', clientName: 'Fake', syncedAt: '', totalJobs: 1,
        jobs: [{ rawUrl: source, canonicalUrl: source, date: '', score: 0, scoredJobId: '', status: 'PENDING' }],
      };
      await alignAndFilterCandidateSegmentJobs([segment], new Set(unique), async (url) => resolved.get(url) || url);
      assert.equal(segment.jobs[0]?.canonicalUrl, target);
      assert.throws(() => resolveMappedShortlinks([source], new Map()), /missing=1, unchanged=0/);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
