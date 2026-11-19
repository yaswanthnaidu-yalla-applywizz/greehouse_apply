import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { remediateUncommittedFields } from '../src/submitter/realtimeRemediator.js';
import { validateGreenhouseSubmission } from '../src/submitter/greenhouseValidation.js';
import type { ApplicationRow } from '../src/db/applications.js';
import type { ProfileRow } from '../src/db/profiles.js';

describe('Greenhouse Real-Time Remediation Integration', () => {
  let browser: Browser;
  let page: Page;

  const mockProfile: Partial<ProfileRow> = {
    applywizz_id: 'AWL-GH-INTEG',
    client_name: 'Morgan Blake',
    first_name: 'Morgan',
    last_name: 'Blake',
    email: 'morgan@example.com',
    location: 'Seattle, WA',
    country: 'United States',
    work_authorization: 'US Citizen',
    requires_sponsorship: false,
    raw_api_payload: {
      additional_information: {
        onsite_willingness: 'Yes',
      },
    },
  };

  before(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  after(async () => {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
  });

  it('remediates uncommitted required diversity/authorization dropdown and allows gate to pass', async () => {
    await page.setContent(`
      <form id="application_form">
        <div class="field">
          <label for="first_name">First Name</label>
          <input type="text" id="first_name" name="first_name" value="Morgan">
        </div>
        <div class="field">
          <label for="work_auth">Work Authorization Status</label>
          <select id="work_auth" name="work_auth">
            <option value="">-- Please select --</option>
            <option value="authorized">I am authorized to work in the US</option>
            <option value="requires_sponsorship">I require visa sponsorship</option>
          </select>
        </div>
        <button type="submit" id="submit_app">Submit Application</button>
      </form>
    `);

    const application: ApplicationRow = {
      id: 'app-gh-integ-1',
      applywizz_id: 'AWL-GH-INTEG',
      job_url: 'https://boards.greenhouse.io/acme/jobs/999',
      status: 'APPLYING',
      resolved_fields: [
        {
          fieldId: 'first_name',
          name: 'first_name',
          type: 'text',
          label: 'First Name',
          value: 'Morgan',
          source: 'supabase',
          resolvedByTier: 1,
          confidence: 1.0,
          isRequired: true,
        } as any,
        {
          fieldId: 'work_auth',
          name: 'work_auth',
          type: 'select',
          label: 'Work Authorization Status',
          value: '', // uncommitted!
          source: 'unresolved',
          resolvedByTier: null,
          confidence: 0,
          isRequired: true,
        } as any,
      ],
    } as any;

    const fillSummary: any = {
      applicationId: 'app-gh-integ-1',
      jobUrl: application.job_url,
      totalFields: 2,
      filledFields: 1,
      failedFields: 1,
      results: [
        { fieldId: 'first_name', label: 'First Name', success: true, domCommitted: true, isRequired: true, valuePopulated: 'Morgan' },
        { fieldId: 'work_auth', label: 'Work Authorization Status', success: false, domCommitted: false, isRequired: true, valuePopulated: '' },
      ],
    };

    // Before remediation: submission gate MUST fail
    const initialGate = await validateGreenhouseSubmission(page, application, fillSummary);
    assert.equal(initialGate.ok, false, 'Initial gate must fail with uncommitted field');

    // Trigger real-time remediation
    const remediation = await remediateUncommittedFields(
      page,
      ['Work Authorization Status'],
      application,
      {
        persistToDb: false,
        getProfileFn: async () => mockProfile as ProfileRow,
        getResumeFn: async () => null,
        llmCallFn: async () => ({
          answer: 'I am authorized to work in the US',
          confidence: 0.95,
          reasoning: 'Candidate is US Citizen',
        }),
      }
    );

    assert.equal(remediation.remediatedCount, 1);
    assert.equal(remediation.allResolved, true);

    // After remediation: update fillSummary result and re-validate submission gate
    fillSummary.results[1].success = true;
    fillSummary.results[1].domCommitted = true;
    fillSummary.results[1].valuePopulated = remediation.remediatedFields[0].value;
    const secondGate = await validateGreenhouseSubmission(page, application, fillSummary);
    assert.equal(secondGate.ok, true, 'Submission gate must pass after successful remediation');
  });
});
