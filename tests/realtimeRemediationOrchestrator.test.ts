import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import {
  remediateUncommittedFields,
} from '../src/submitter/realtimeRemediator.js';
import type { ApplicationRow } from '../src/db/applications.js';
import type { ProfileRow } from '../src/db/profiles.js';

describe('Realtime Remediation Orchestrator', () => {
  let browser: Browser;
  let page: Page;

  const mockProfile: Partial<ProfileRow> = {
    applywizz_id: 'AWL-TEST-ORCH',
    client_name: 'Alex Rivera',
    first_name: 'Alex',
    last_name: 'Rivera',
    email: 'alex@example.com',
    location: 'Denver, CO',
    country: 'United States',
    work_authorization: 'US Citizen',
    requires_sponsorship: false,
    raw_api_payload: {
      additional_information: {
        onsite_willingness: 'Yes',
      },
    },
  };

  const mockApp: ApplicationRow = {
    id: 'app-test-orch-123',
    applywizz_id: 'AWL-TEST-ORCH',
    job_url: 'https://boards.greenhouse.io/acme/jobs/12345',
    status: 'APPLYING',
    resolved_fields: [],
  } as any;

  before(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  after(async () => {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
  });

  it('scrapes, resolves, and commits multiple uncommitted fields successfully', async () => {
    await page.setContent(`
      <form id="app_form">
        <div class="field">
          <label for="auth_select">Are you authorized to work in the US?</label>
          <select id="auth_select" name="auth">
            <option value="">-- Select --</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </div>
        <div class="field">
          <label for="hybrid_pref">Are you open to hybrid work in Denver?</label>
          <input type="text" id="hybrid_pref" name="hybrid" value="">
        </div>
      </form>
    `);

    const result = await remediateUncommittedFields(
      page,
      ['Are you authorized to work in the US?', 'Are you open to hybrid work in Denver?'],
      mockApp,
      {
        persistToDb: false,
        getProfileFn: async () => mockProfile as ProfileRow,
        getResumeFn: async () => null,
        llmCallFn: async (prompt) => {
          if (prompt.includes('Label: "Are you authorized to work in the US?"')) {
            return { answer: 'Yes', confidence: 0.95, reasoning: 'US citizen' };
          }
          return { answer: 'Yes', confidence: 0.9, reasoning: 'Willing hybrid' };
        },
      }
    );

    assert.equal(result.attemptedCount, 2);
    assert.equal(result.remediatedCount, 2);
    assert.equal(result.allResolved, true);
    assert.equal(result.remediatedFields.length, 2);

    // Verify session report and remediation metadata
    assert.ok(result.sessionReport, 'Session report must be present');
    assert.equal(result.sessionReport.attemptedCount, 2);
    assert.equal(result.sessionReport.resolvedCount, 2);
    assert.equal(result.sessionReport.failedCount, 0);
    assert.equal(result.sessionReport.items.length, 2);
    assert.ok(result.sessionReport.items[0].issueFaced);
    assert.ok(result.sessionReport.items[0].issueFixed);
    assert.equal(result.sessionReport.items[0].status, 'resolved');

    // Verify error_details attached to application
    assert.ok((mockApp.error_details as any)?.remediationReport, 'error_details.remediationReport must be set');

    // Verify per-field remediation metadata
    assert.ok(result.remediatedFields[0].remediation);
    assert.equal(result.remediatedFields[0].remediation.status, 'resolved');
    assert.ok(result.remediatedFields[0].remediation.issueFaced);

    // Verify DOM updates
    const selectVal = await page.$eval('#auth_select', (el: HTMLSelectElement) => el.options[el.selectedIndex]?.text);
    const textVal = await page.$eval('#hybrid_pref', (el: HTMLInputElement) => el.value);
    assert.equal(selectVal, 'Yes');
    assert.equal(textVal, 'Yes');
  });

  it('handles partial resolution when one field fails closed', async () => {
    await page.setContent(`
      <form id="app_form">
        <div class="field">
          <label for="auth_select2">Are you authorized to work in the US?</label>
          <select id="auth_select2" name="auth2">
            <option value="">-- Select --</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </div>
        <div class="field">
          <label for="secret_code">Employee Referral Code</label>
          <input type="text" id="secret_code" name="code" value="">
        </div>
      </form>
    `);

    const result = await remediateUncommittedFields(
      page,
      ['Are you authorized to work in the US?', 'Employee Referral Code'],
      mockApp,
      {
        persistToDb: false,
        getProfileFn: async () => mockProfile as ProfileRow,
        getResumeFn: async () => null,
        llmCallFn: async (prompt) => {
          if (prompt.includes('Label: "Are you authorized to work in the US?"')) {
            return { answer: 'Yes', confidence: 0.95, reasoning: 'US citizen' };
          }
          // Referral code: candidate does not have it, fail closed
          return { answer: '', confidence: 0.1, reasoning: 'Unknown' };
        },
      }
    );

    assert.equal(result.attemptedCount, 2);
    assert.equal(result.remediatedCount, 1);
    assert.equal(result.allResolved, false);
    assert.equal(result.errors.length, 1);

    // Verify sessionReport recorded the failed closed attempt
    assert.ok(result.sessionReport);
    assert.equal(result.sessionReport.attemptedCount, 2);
    assert.equal(result.sessionReport.resolvedCount, 1);
    assert.equal(result.sessionReport.failedCount, 1);
    assert.equal(result.sessionReport.items.length, 2);

    const failedItem = result.sessionReport.items.find((i) => i.label === 'Employee Referral Code');
    assert.ok(failedItem);
    assert.equal(failedItem.status, 'failed_closed');
    assert.ok(failedItem.issueFaced);
    assert.ok(failedItem.issueFixed);
  });

  it('respects timeout circuit breaker', async () => {
    await page.setContent('<div class="field"><label>Some field</label><input type="text"></div>');

    const result = await remediateUncommittedFields(
      page,
      ['Some field'],
      mockApp,
      {
        persistToDb: false,
        timeoutMs: 10, // 10ms hard limit
        getProfileFn: async () => {
          await new Promise((r) => setTimeout(r, 50)); // Takes 50ms
          return mockProfile as ProfileRow;
        },
        getResumeFn: async () => null,
      }
    );

    assert.equal(result.allResolved, false);
    assert.ok(result.errors.some((e) => e.includes('timeout') || e.includes('aborted')));
  });
});
