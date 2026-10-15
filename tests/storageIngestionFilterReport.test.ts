import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { IngestFilterReport } from '../src/types/index.js';

const state = vi.hoisted(() => ({
  pipelineResult: null as any,
  listedFiles: [] as Array<{ name: string; created_at?: string }>,
  emailResult: { success: true } as { success: boolean; error?: string },
  sendEmail: vi.fn(),
  upsertIngestRun: vi.fn(),
}));

vi.mock('../src/config/env.js', () => ({
  config: {
    OUTPUT_DIR: 'output',
    WORKER_POOL_SIZE: 1,
    NODE_ENV: 'test',
    RAILWAY_ENV: false,
    ENABLE_PIPELINE_STOP: false,
  },
  default: {
    OUTPUT_DIR: 'output',
    WORKER_POOL_SIZE: 1,
    NODE_ENV: 'test',
    RAILWAY_ENV: false,
    ENABLE_PIPELINE_STOP: false,
  },
}));
vi.mock('../src/db/client.js', () => ({
  getDbClient: () => ({
    storage: {
      from: () => ({
        download: async () => ({ data: new Blob(['applywizz_id,job_url\r\nAWL-1,https://boards.greenhouse.io/example/jobs/1']) }),
        move: async () => ({ error: null }),
      }),
    },
  }),
  isSupabaseConfigured: () => true,
  resolveSupabaseCredentials: () => ({ url: 'https://supabase.example', serviceKey: 'server-key', serviceKeySource: 'test' }),
  listSupabaseKeyCandidates: () => ({
    url: 'https://supabase.example',
    candidates: [{ source: 'test', key: 'server-key' }],
  }),
  createSupabaseServerClient: () => ({
    storage: {
      from: () => ({
        list: async () => ({ data: state.listedFiles, error: null }),
      }),
    },
  }),
}));
vi.mock('../src/db/supabaseKeyDiagnostics.js', () => ({
  getSupabaseKeyDiagnostics: () => ({
    summary: 'test credentials',
    keyHadSurroundingWhitespace: false,
    jwtRole: 'service_role',
    keyShape: 'test',
    urlRefMatch: true,
  }),
}));
vi.mock('../src/db/storage.js', () => ({ CSV_UPLOADS_BUCKET: 'csv_uploads' }));
vi.mock('../src/db/ingestRuns.js', () => ({
  upsertIngestRun: state.upsertIngestRun,
}));
vi.mock('../src/db/statsRollup.js', () => ({ runStatsRollup: vi.fn(async () => undefined) }));
vi.mock('../src/candidate/csvUploadValidation.js', () => ({
  selectCsvIngestionTarget: (fileName?: string, files: Array<{ name: string }> = []) =>
    fileName ? { name: fileName, createdAt: null } : files[0] || null,
}));
vi.mock('../src/orchestrator/pipeline.js', () => ({
  V1Pipeline: class {
    async runFullPipeline() {
      if (state.pipelineResult instanceof Error) throw state.pipelineResult;
      return state.pipelineResult;
    }
  },
}));
vi.mock('../src/services/azureEmail.js', () => ({ sendEmail: state.sendEmail }));
vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  haltWithDevAlert: (_module: string, message: string) => { throw new Error(message); },
}));
vi.mock('../src/utils/pipelineLogging.js', () => ({ isPipelineCompactLogging: () => true }));

import { ingestCsvFromStorage } from '../src/scanner/storageCsvIngestion.js';
import { clearCurrentIngestFilterReport, getCurrentIngestFilterReportPath, writeCurrentIngestFilterReport } from '../src/scanner/ingestFilterReport.js';

function pipelineResult(report: IngestFilterReport = {
  clearanceLinks: [],
  excludedCompanyApplications: [],
  latestEmployerApplications: [],
}, status: 'SUCCESS' | 'PARTIAL' | 'FAILED' = 'SUCCESS') {
  return {
    status,
    uniqueCandidates: 1,
    uniqueUrls: 1,
    resolvedApplications: 0,
    durationMs: 10,
    ingestFilterReport: report,
  };
}

beforeEach(() => {
  state.pipelineResult = pipelineResult();
  state.listedFiles = [];
  state.emailResult = { success: true };
  state.sendEmail.mockReset().mockImplementation(async () => state.emailResult);
  state.upsertIngestRun.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await clearCurrentIngestFilterReport();
});

describe('storage ingestion filter report lifecycle', () => {
  it('emails and retains a CSV after a completed run, including an empty report', async () => {
    const result = await ingestCsvFromStorage({ fileName: 'input.csv' });

    expect(result.success).toBe(true);
    expect(state.sendEmail).toHaveBeenCalledOnce();
    expect(state.sendEmail.mock.calls[0][0]).toMatchObject({
      to: 'yaswanthnaiduyalla@applywizz.ai',
      attachments: [{
        name: 'ingest-filter-report.csv',
        contentType: 'text/csv',
        contentBytes: Buffer.from('section,awl_id,job_url\r\n').toString('base64'),
      }],
    });
    await expect(fs.readFile(getCurrentIngestFilterReportPath(), 'utf8')).resolves.toBe('section,awl_id,job_url\r\n');
  });

  it('keeps ingestion completed and the report downloadable when email sending fails', async () => {
    state.pipelineResult = pipelineResult({
      clearanceLinks: ['https://boards.greenhouse.io/example/jobs/1'],
      excludedCompanyApplications: [],
      latestEmployerApplications: [],
    });
    state.emailResult = { success: false, error: 'Graph unavailable' };

    const result = await ingestCsvFromStorage({ fileName: 'input.csv' });

    expect(result.success).toBe(true);
    expect(result.notificationError).toContain('Graph unavailable');
    expect(state.upsertIngestRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    await expect(fs.readFile(getCurrentIngestFilterReportPath(), 'utf8')).resolves.toContain('clearance');
  });

  it('emails a non-empty report as the generated CSV attachment', async () => {
    state.pipelineResult = pipelineResult({
      clearanceLinks: [],
      excludedCompanyApplications: [{ applywizzId: 'AWL-2', jobUrl: 'https://boards.greenhouse.io/example/jobs/2' }],
      latestEmployerApplications: [],
    });

    await ingestCsvFromStorage({ fileName: 'input.csv' });

    expect(state.sendEmail).toHaveBeenCalledOnce();
    const attachment = state.sendEmail.mock.calls[0][0].attachments[0];
    expect(Buffer.from(attachment.contentBytes, 'base64').toString('utf8')).toContain(
      'excluded_company,AWL-2,https://boards.greenhouse.io/example/jobs/2'
    );
  });

  it('does not email a report when no CSV is available and clears the previous report', async () => {
    await writeCurrentIngestFilterReport({
      clearanceLinks: ['https://boards.greenhouse.io/old/jobs/1'],
      excludedCompanyApplications: [],
      latestEmployerApplications: [],
    });

    const result = await ingestCsvFromStorage();

    expect(result.success).toBe(false);
    expect(state.sendEmail).not.toHaveBeenCalled();
    await expect(fs.access(getCurrentIngestFilterReportPath())).rejects.toThrow();
  });

  it('does not email when the pipeline aborts', async () => {
    const abort = new Error('stopped');
    abort.name = 'PipelineAbortedError';
    state.pipelineResult = abort;

    const result = await ingestCsvFromStorage({ fileName: 'input.csv' });

    expect(result.aborted).toBe(true);
    expect(state.sendEmail).not.toHaveBeenCalled();
  });

  it('does not email when the pipeline fails', async () => {
    state.pipelineResult = new Error('pipeline failed');

    await expect(ingestCsvFromStorage({ fileName: 'input.csv' })).rejects.toThrow('pipeline failed');
    expect(state.sendEmail).not.toHaveBeenCalled();
  });

  it('does not email when the pipeline returns a FAILED status', async () => {
    state.pipelineResult = pipelineResult(undefined, 'FAILED');

    const result = await ingestCsvFromStorage({ fileName: 'input.csv' });

    expect(result.success).toBe(true);
    expect(state.sendEmail).not.toHaveBeenCalled();
    await expect(fs.access(getCurrentIngestFilterReportPath())).rejects.toThrow();
  });
});
