import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { submitLeverApplication, fillLeverForm } from '../src/submitter/leverSubmit.js';
import { submitAshbyApplication } from '../src/submitter/ashbySubmit.js';
import { fillRipplingForm } from '../src/submitter/ripplingFormFiller.js';
import { browserManager } from '../src/submitter/browserManager.js';
import type { ApplicationRow } from '../src/db/applications/types.js';

test('Task 1: Preload Candidate Resume Upfront (Method 8)', async (t) => {
  const tempResume = path.join(os.tmpdir(), `test-preload-${Date.now()}.pdf`);
  fs.writeFileSync(tempResume, '%PDF-1.4 test resume');

  t.after(() => {
    if (fs.existsSync(tempResume)) {
      try { fs.unlinkSync(tempResume); } catch {}
    }
  });

  await t.test('submitLeverApplication fails fast without acquiring browser when candidate lookup fails', async () => {
    let browserAcquired = false;
    const origAcquire = browserManager.acquireBrowser.bind(browserManager);
    (browserManager as any).acquireBrowser = async () => {
      browserAcquired = true;
      return origAcquire();
    };

    try {
      const mockApp: ApplicationRow = {
        id: 'app-fail-fast-lever',
        applywizz_id: 'NON_EXISTENT_AWL_ID_99999',
        job_url: 'https://jobs.lever.co/testco/job123',
        status: 'QUEUED',
        job_title: 'Software Engineer',
        company_name: 'TestCo',
      } as any;

      const result = await submitLeverApplication(mockApp, {
        headless: true,
        updateStatusFn: async () => true,
      });

      assert.strictEqual(result.status, 'FAILED');
      assert.strictEqual(browserAcquired, false, 'Chromium browser must NOT be acquired when resume download fails');
      assert.match(result.errorMessage || '', /profile|resume/i);
    } finally {
      (browserManager as any).acquireBrowser = origAcquire;
    }
  });

  await t.test('submitAshbyApplication fails fast without acquiring browser when candidate lookup fails', async () => {
    let browserAcquired = false;
    const origAcquire = browserManager.acquireBrowser.bind(browserManager);
    (browserManager as any).acquireBrowser = async () => {
      browserAcquired = true;
      return origAcquire();
    };

    try {
      const mockApp: ApplicationRow = {
        id: 'app-fail-fast-ashby',
        applywizz_id: 'NON_EXISTENT_AWL_ID_99999',
        job_url: 'https://jobs.ashbyhq.com/testco/job123',
        status: 'QUEUED',
        job_title: 'Software Engineer',
        company_name: 'TestCo',
      } as any;

      const result = await submitAshbyApplication(mockApp, {
        headless: true,
        updateStatusFn: async () => true,
      });

      assert.strictEqual(result.status, 'FAILED');
      assert.strictEqual(browserAcquired, false, 'Chromium browser must NOT be acquired when resume preparation fails');
    } finally {
      (browserManager as any).acquireBrowser = origAcquire;
    }
  });

  await t.test('fillRipplingForm throws immediately if preloadedResumePath does not exist on disk', async () => {
    const mockPage: any = {};
    const nonExistentPath = path.join(os.tmpdir(), 'definitely-does-not-exist.pdf');
    await assert.rejects(
      async () => {
        await fillRipplingForm(mockPage, [
          { fieldId: 'f1', label: 'Resume', type: 'file', isRequired: true, value: 'my_resume.pdf' } as any
        ], nonExistentPath);
      },
      /does not exist/i
    );
  });

  await t.test('fillLeverForm uploads preloadedResumePath directly without re-downloading', async () => {
    let uploadedFile: string | null = null;
    const mockPage: any = {
      isClosed: () => false,
      frames: () => [],
      evaluate: async () => ({ surfaces: [] }),
      locator: (selector: string) => {
        if (selector.includes('resume')) {
          return {
            count: async () => 1,
            first: () => ({
              count: async () => 1,
              setInputFiles: async (file: string) => {
                uploadedFile = file;
              },
            }),
          };
        }
        return {
          count: async () => 0,
          first: () => ({ count: async () => 0 }),
        };
      },
      waitForTimeout: async () => {},
    };

    const mockProfile: any = {
      applywizz_id: 'AWL-101',
      name: 'Jane Doe',
      resume_storage_path: 'profiles/AWL-101/resume.pdf',
    };

    const fillResult = await fillLeverForm(mockPage, { resolved_fields: [] } as any, mockProfile, {
      preloadedResumePath: tempResume,
      humanize: false,
    });

    assert.strictEqual(uploadedFile, tempResume, 'Preloaded resume must be uploaded directly');
    assert.ok(fillResult.filledCount >= 1);
  });
});
