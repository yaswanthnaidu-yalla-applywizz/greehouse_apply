import { describe, it, expect, vi } from 'vitest';
import { isAshbyJobClosedOnDom } from '../src/scanner/ashbyScanner.js';
import { waitForAshbyApplicationReady, submitAshbyApplication } from '../src/submitter/ashbySubmit.js';

describe('Ashby Scanner & Submitter - 404 Fast Detection and Empty Field Safeguards', () => {
  describe('isAshbyJobClosedOnDom', () => {
    it('detects 404 / Job Not Found texts', async () => {
      const mockPage: any = {
        evaluate: vi.fn().mockResolvedValue('Oops! 404 - Job not found. The position has been filled.'),
      };
      expect(await isAshbyJobClosedOnDom(mockPage)).toBe(true);
    });

    it('detects no longer accepting applications text', async () => {
      const mockPage: any = {
        evaluate: vi.fn().mockResolvedValue('We are no longer accepting applications for this role.'),
      };
      expect(await isAshbyJobClosedOnDom(mockPage)).toBe(true);
    });

    it('returns false for normal active job pages', async () => {
      const mockPage: any = {
        evaluate: vi.fn().mockResolvedValue('Senior Software Engineer - Full Time. Apply below.'),
      };
      expect(await isAshbyJobClosedOnDom(mockPage)).toBe(false);
    });
  });

  describe('waitForAshbyApplicationReady', () => {
    it('throws JOB_CLOSED immediately when page text indicates closed/404', async () => {
      const mockPage: any = {
        evaluate: vi.fn().mockResolvedValue('404: Job not found'),
      };

      await expect(waitForAshbyApplicationReady(mockPage, 1000)).rejects.toMatchObject({
        code: 'JOB_CLOSED',
        stage: 'PAGE_LOAD',
        classification: 'DATA_FAULT:JOB_CLOSED',
      });
    });
  });

  describe('submitAshbyApplication empty resolved_fields guard', () => {
    it('rejects submission immediately if resolved_fields is empty', async () => {
      const emptyApp: any = {
        id: 'app-empty-1',
        applywizz_id: 'user-1',
        job_url: 'https://jobs.ashbyhq.com/test/job-1',
        resolved_fields: [],
      };

      await expect(submitAshbyApplication(emptyApp)).rejects.toMatchObject({
        stage: 'PREFLIGHT',
        classification: 'DATA_FAULT:EMPTY_RESOLVED_FIELDS',
      });
    });

    it('rejects submission immediately if resolved_fields is null/undefined', async () => {
      const nullApp: any = {
        id: 'app-null-1',
        applywizz_id: 'user-1',
        job_url: 'https://jobs.ashbyhq.com/test/job-1',
        resolved_fields: null,
      };

      await expect(submitAshbyApplication(nullApp)).rejects.toMatchObject({
        stage: 'PREFLIGHT',
        classification: 'DATA_FAULT:EMPTY_RESOLVED_FIELDS',
      });
    });
  });
});
