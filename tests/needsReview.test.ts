import { describe, it, expect } from 'vitest';
import { applicationNeedsOperatorReview, type NeedsReviewField } from '../src/resolver/needsReview.js';

describe('Review Gate Enforcement with Provenance', () => {
  it('allows deterministic required answers with policy provenance to pass auto-queue', () => {
    const fields: (NeedsReviewField & { provenance?: any })[] = [
      {
        isRequired: true,
        source: 'policy',
        value: 'No',
        label: 'Do you consent to receive SMS communications?',
        provenance: {
          family: 'agreement_consent',
          policyId: 'policy_sms_consent',
        },
      },
    ];
    expect(applicationNeedsOperatorReview(fields)).toBe(false);
  });

  it('allows deterministic required answers with profile payload provenance', () => {
    const fields: (NeedsReviewField & { provenance?: any })[] = [
      {
        isRequired: true,
        source: 'policy',
        value: 'Citizen',
        label: 'Work Authorization Visa Status',
        provenance: {
          family: 'work_authorization',
          evidenceKind: 'profile_payload',
        },
      },
    ];
    expect(applicationNeedsOperatorReview(fields)).toBe(false);
  });

  it('allows deterministic required answers with resume parse provenance', () => {
    const fields: (NeedsReviewField & { provenance?: any })[] = [
      {
        isRequired: true,
        source: 'resume_parse',
        value: '5550192834',
        label: 'Phone Number',
        provenance: {
          family: 'contact_profile',
          evidenceKind: 'tier2_resume',
        },
      },
    ];
    expect(applicationNeedsOperatorReview(fields)).toBe(false);
  });

  it('allows deterministic required answers with employment history provenance', () => {
    const fields: (NeedsReviewField & { provenance?: any })[] = [
      {
        isRequired: true,
        source: 'supabase',
        value: 'Acme Corp',
        label: 'Current Employer',
        provenance: {
          family: 'employer_history',
          evidenceKind: 'employment_history',
        },
      },
    ];
    expect(applicationNeedsOperatorReview(fields)).toBe(false);
  });

  it('allows deterministic required answers with QA match provenance', () => {
    const fields: (NeedsReviewField & { provenance?: any })[] = [
      {
        isRequired: true,
        source: 'supabase',
        value: '5 years',
        label: 'Years of Experience with TypeScript',
        provenance: {
          family: 'availability_education',
          evidenceKind: 'qa_match',
        },
      },
    ];
    expect(applicationNeedsOperatorReview(fields)).toBe(false);
  });

  it('allows deterministic required answers with posting location provenance', () => {
    const fields: (NeedsReviewField & { provenance?: any })[] = [
      {
        isRequired: true,
        source: 'policy',
        value: 'New York, NY',
        label: 'Preferred Office Location',
        provenance: {
          family: 'workplace_preference',
          evidenceKind: 'job_posting_location',
        },
      },
    ];
    expect(applicationNeedsOperatorReview(fields)).toBe(false);
  });

  it('allows old rows without provenance if resolved deterministically', () => {
    const fields: NeedsReviewField[] = [
      {
        isRequired: true,
        source: 'supabase',
        value: 'John',
        label: 'First Name',
      },
      {
        isRequired: true,
        source: 'resume_parse',
        value: 'Software Engineer',
        label: 'Current Title',
      },
    ];
    expect(applicationNeedsOperatorReview(fields)).toBe(false);
  });

  it('blocks required AI fields from auto-queue', () => {
    const fields: NeedsReviewField[] = [
      {
        isRequired: true,
        source: 'ai',
        value: 'I love writing scalable backend code.',
        label: 'Why are you interested in this role?',
      },
    ];
    expect(applicationNeedsOperatorReview(fields)).toBe(true);
  });

  it('blocks required unresolved fields from auto-queue', () => {
    const fields: NeedsReviewField[] = [
      {
        isRequired: true,
        source: 'unresolved',
        value: '',
        label: 'Custom Portfolio Link',
      },
    ];
    expect(applicationNeedsOperatorReview(fields)).toBe(true);
  });

  it('blocks mandatory cover letter fields from auto-queue', () => {
    const fields: NeedsReviewField[] = [
      {
        isRequired: true,
        source: 'supabase',
        value: '',
        label: 'Cover Letter',
      },
    ];
    expect(applicationNeedsOperatorReview(fields)).toBe(true);
  });

  it('blocks negative salary answers from auto-queue', () => {
    const fields: NeedsReviewField[] = [
      {
        isRequired: true,
        source: 'supabase',
        value: 'Decline to state',
        label: 'Salary expectation',
      },
    ];
    expect(applicationNeedsOperatorReview(fields)).toBe(true);
  });
});
