import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AnswerResolver, type ResolutionJobContext, type CachedResolutionEvidence } from '../src/resolver/answerResolver.js';
import { ResolverWorkerPool } from '../src/resolver/resolverWorkerPool.js';
import type { ProfileRow } from '../db/profiles.js';
import type { ScannedField, ApplicationRow, TemplateRow } from '../src/types/index.js';

describe('Shared Resolution Pipeline Parity', () => {
  const mockProfile: ProfileRow = {
    applywizz_id: 'AWL-PARITY-1',
    client_name: 'Jane Candidate',
    email: 'jane.candidate@example.com',
    phone: '+1 555-019-2834',
    city: 'Seattle',
    state: 'WA',
    country: 'United States',
    current_company: 'Acme Corp',
    current_title: 'Staff Engineer',
    linkedin_url: 'https://linkedin.com/in/janecandidate',
    github_url: 'https://github.com/janecandidate',
    portfolio_url: 'https://janecandidate.dev',
    visa_status: 'Citizen',
    work_authorization: 'US Citizen',
    salary_range: '$140k - $160k',
  } as unknown as ProfileRow;

  const sampleFields: ScannedField[] = [
    {
      fieldId: 'field-sms',
      name: 'sms_consent',
      type: 'radio',
      label: 'Do you consent to receive SMS communications regarding your application?',
      options: ['Yes', 'No'],
      isRequired: true,
      metadata: { selector: '#sms_consent' },
    },
    {
      fieldId: 'field-phone',
      name: 'phone_number',
      type: 'text',
      label: 'Mobile Phone Number',
      isRequired: true,
      metadata: { inputType: 'tel', selector: '#phone' },
    },
    {
      fieldId: 'field-employer',
      name: 'current_employer',
      type: 'text',
      label: 'Current Employer',
      isRequired: true,
      metadata: { selector: '#current_employer' },
    },
    {
      fieldId: 'field-office',
      name: 'office_location',
      type: 'select',
      label: 'Preferred Office Location',
      options: ['New York, NY', 'Austin, TX', 'San Francisco, CA'],
      isRequired: true,
      metadata: { selector: '#office_location' },
    },
    {
      fieldId: 'field-relocate',
      name: 'relocation_willingness',
      type: 'radio',
      label: 'Are you open to relocation?',
      options: ['Yes, willing to relocate', 'No'],
      isRequired: true,
      metadata: { selector: '#relocate' },
    },
    {
      fieldId: 'field-creative',
      name: 'challenge_story',
      type: 'textarea',
      label: 'Describe a significant engineering challenge you overcame recently.',
      isRequired: true,
      metadata: { selector: '#challenge_story' },
    },
  ];

  const jobContext: ResolutionJobContext = {
    companyName: 'OmniCorp',
    jobTitle: 'Senior Infrastructure Engineer',
    jobUrl: 'https://boards.greenhouse.io/omnicorp/jobs/12345',
    jobPostingLocation: 'New York, NY',
    jobPostingFacts: {
      location: 'New York, NY',
      locations: ['New York, NY'],
    },
  };

  const evidence: CachedResolutionEvidence = {
    profile: mockProfile,
    parsedResume: {
      applywizz_id: 'AWL-PARITY-1',
      raw_text: 'Jane Candidate | Staff Engineer | jane.candidate@example.com | (555) 019-2834',
      structured: {
        phone: '5550192834',
        skills: ['TypeScript', 'Kubernetes'],
      },
    } as any,
    qaEntries: [],
  };

  it('AnswerResolver resolves fields consistently with typed policies and provenance', async () => {
    const resolver = new AnswerResolver();
    const resolved = await resolver.resolveFormFields(
      'AWL-PARITY-1',
      sampleFields,
      jobContext,
      evidence,
      { mode: 'shadow' }
    );

    assert.equal(resolved.length, sampleFields.length);

    // 1. SMS Consent
    const sms = resolved.find((f) => f.fieldId === 'field-sms');
    assert.ok(sms);
    assert.equal(sms.value, 'No');
    assert.equal(sms.source, 'policy');
    assert.equal(sms.provenance?.family, 'agreement_consent');
    assert.equal(sms.isRequired, true);
    assert.ok(
      sms.provenance?.policyId === 'sms-consent' || sms.provenance?.policyId === 'policy_sms_consent',
      `Unexpected policyId: ${sms.provenance?.policyId}`
    );
    assert.equal(sms.metadata?.selector, '#sms_consent');

    // 2. Phone
    const phone = resolved.find((f) => f.fieldId === 'field-phone');
    assert.ok(phone);
    assert.ok(phone.value.includes('5550192834') || phone.value.includes('555-019-2834'));
    assert.ok(phone.source === 'supabase' || phone.source === 'resume_parse');
    assert.equal(phone.isRequired, true);

    // 3. Current Employer (must not match candidate email)
    const employer = resolved.find((f) => f.fieldId === 'field-employer');
    assert.ok(employer);
    assert.notEqual(employer.value, 'jane.candidate@example.com');

    // 4. Preferred Office Location (mapped to posting location)
    const office = resolved.find((f) => f.fieldId === 'field-office');
    assert.ok(office);
    assert.equal(office.value, 'New York, NY');
    assert.equal(office.source, 'policy');
    assert.ok(
      office.provenance?.policyId === 'workplace-posting-location' ||
        office.provenance?.policyId === 'policy_workplace_location',
      `Unexpected office policyId: ${office.provenance?.policyId}`
    );

    // 5. Relocation willingness (when posting location exists, does not force relocation affirmative)
    // But when jobPostingLocation is removed, relocation should pick affirmative option
    const noLocContext: ResolutionJobContext = {
      ...jobContext,
      jobPostingLocation: undefined,
      jobPostingFacts: undefined,
    };
    const resolvedNoLoc = await resolver.resolveFormFields(
      'AWL-PARITY-1',
      sampleFields,
      noLocContext,
      evidence,
      { mode: 'shadow' }
    );
    const relocateNoLoc = resolvedNoLoc.find((f) => f.fieldId === 'field-relocate');
    assert.ok(relocateNoLoc);
    assert.equal(relocateNoLoc.value, 'Yes, willing to relocate');
    assert.equal(relocateNoLoc.source, 'policy');
    assert.ok(
      relocateNoLoc.provenance?.policyId === 'workplace-relocation-affirmative' ||
        relocateNoLoc.provenance?.policyId === 'policy_relocation_affirmative',
      `Unexpected relocate policyId: ${relocateNoLoc.provenance?.policyId}`
    );

    // 6. Creative field in shadow mode
    const creative = resolved.find((f) => f.fieldId === 'field-creative');
    assert.ok(creative);
    assert.equal(creative.source, 'unresolved');
    assert.equal(creative.provenance?.evidenceKind, 'tier5_required');
  });

  it('normal resolution and worker pool produce identical resolved field structures', async () => {
    const resolver = new AnswerResolver();
    const directResolved = await resolver.resolveFormFields(
      'AWL-PARITY-1',
      sampleFields,
      jobContext,
      evidence,
      { mode: 'shadow' }
    );

    // Worker pool uses resolver under the hood
    const workerPool = new ResolverWorkerPool();
    const workerResolved = await (workerPool as any).resolveFieldsWithSharedResolver(
      'AWL-PARITY-1',
      sampleFields,
      jobContext,
      evidence,
      { mode: 'shadow' }
    );

    assert.equal(workerResolved.length, directResolved.length);
    for (let i = 0; i < directResolved.length; i++) {
      const d = directResolved[i];
      const w = workerResolved[i];
      assert.equal(w.fieldId, d.fieldId, `fieldId match at index ${i}`);
      assert.equal(w.name, d.name, `name match at index ${i}`);
      assert.equal(w.value, d.value, `value match at index ${i}`);
      assert.equal(w.source, d.source, `source match at index ${i}`);
      assert.equal(w.isRequired, d.isRequired, `isRequired match at index ${i}`);
      assert.deepEqual(w.provenance, d.provenance, `provenance match at index ${i}`);
      assert.deepEqual(w.metadata, d.metadata, `metadata match at index ${i}`);
    }
  });
});
