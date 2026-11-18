import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { remediateUncommittedFields } from '../src/submitter/realtimeRemediator.js';
import { verifyRequiredFieldsCommitted } from '../src/submitter/ashbyFormFiller.js';
import type { ApplicationRow } from '../src/db/applications.js';
import type { ProfileRow } from '../src/db/profiles.js';

describe('Ashby Real-Time Remediation Integration', () => {
  let browser: Browser;
  let page: Page;

  const mockProfile: Partial<ProfileRow> = {
    applywizz_id: 'AWL-ASHBY-INTEG',
    client_name: 'Casey Quinn',
    first_name: 'Casey',
    last_name: 'Quinn',
    email: 'casey@example.com',
    location: 'Chicago, IL',
    country: 'United States',
    work_authorization: 'US Citizen',
    requires_sponsorship: false,
    raw_api_payload: {
      additional_information: {
        visa_status: 'Authorized',
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

  it('detects uncommitted Ashby field, remediates in real-time, and passes verification', async () => {
    await page.setContent(`
      <form class="ashby-application-form">
        <div data-field-path="_systemfield_name">
          <input type="text" name="_systemfield_name" value="Casey Quinn">
        </div>
        <div data-field-path="custom_sponsorship" class="field">
          <label>Do you require visa sponsorship?</label>
          <label><input type="radio" name="custom_sponsorship" value="Yes"> Yes</label>
          <label><input type="radio" name="custom_sponsorship" value="No"> No</label>
        </div>
      </form>
    `);

    const application: ApplicationRow = {
      id: 'app-ashby-integ-1',
      applywizz_id: 'AWL-ASHBY-INTEG',
      job_url: 'https://jobs.ashbyhq.com/acme/1234',
      status: 'APPLYING',
      resolved_fields: [
        {
          fieldId: '_systemfield_name',
          name: '_systemfield_name',
          type: 'text',
          label: 'Name',
          value: 'Casey Quinn',
          source: 'supabase',
          resolvedByTier: 1,
          confidence: 1.0,
          isRequired: true,
        } as any,
        {
          fieldId: 'custom_sponsorship',
          name: 'custom_sponsorship',
          type: 'radio',
          label: 'Do you require visa sponsorship?',
          value: '', // uncommitted!
          source: 'unresolved',
          resolvedByTier: null,
          confidence: 0,
          isRequired: true,
        } as any,
      ],
    } as any;

    const requiredPaths = ['_systemfield_name', 'custom_sponsorship'];

    // 1. Initial verification fails because custom_sponsorship radio is not checked
    const initialCheck = await verifyRequiredFieldsCommitted(page, requiredPaths);
    assert.equal(initialCheck.allCommitted, false);
    assert.deepEqual(initialCheck.missingFields, ['custom_sponsorship']);

    // 2. Trigger real-time remediation for missing label
    const remediation = await remediateUncommittedFields(
      page,
      ['Do you require visa sponsorship?'],
      application,
      {
        persistToDb: false,
        getProfileFn: async () => mockProfile as ProfileRow,
        getResumeFn: async () => null,
        llmCallFn: async () => ({
          answer: 'No',
          confidence: 0.95,
          reasoning: 'US citizen requires no visa',
        }),
      }
    );

    assert.equal(remediation.remediatedCount, 1);
    assert.equal(remediation.allResolved, true);

    // 3. Re-verify DOM committed state on Ashby form
    const secondCheck = await verifyRequiredFieldsCommitted(page, requiredPaths);
    assert.equal(secondCheck.allCommitted, true, 'All fields should be committed after remediation');
    assert.deepEqual(secondCheck.missingFields, []);
  });
});
