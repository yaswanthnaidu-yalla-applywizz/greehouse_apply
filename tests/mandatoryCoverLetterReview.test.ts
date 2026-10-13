import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applicationNeedsOperatorReview } from '../src/resolver/needsReview.js';

describe('Mandatory Cover Letter Routing Guard', () => {
  it('returns true when a required cover letter field is present', () => {
    const fields: any[] = [
      { fieldId: 'first_name', name: 'first_name', label: 'First Name', value: 'John', isRequired: true, source: 'supabase' },
      { fieldId: 'resume', name: 'resume', label: 'Resume/CV', value: 'resumes/john.pdf', isRequired: true, source: 'supabase' },
      // Tier 1 sets value: '' and source: 'supabase' for cover letters
      { fieldId: 'cover_letter', name: 'cover_letter', label: 'Cover Letter', value: '', isRequired: true, source: 'supabase' },
    ];
    const needsReview = applicationNeedsOperatorReview(fields);
    assert.equal(needsReview, true, 'Applications with mandatory cover letter must require operator review');
  });

  it('returns false when cover letter is optional and other fields are resolved', () => {
    const fields: any[] = [
      { fieldId: 'first_name', name: 'first_name', label: 'First Name', value: 'John', isRequired: true, source: 'supabase' },
      { fieldId: 'resume', name: 'resume', label: 'Resume/CV', value: 'resumes/john.pdf', isRequired: true, source: 'supabase' },
      { fieldId: 'cover_letter', name: 'cover_letter', label: 'Cover Letter', value: '', isRequired: false, source: 'supabase' },
    ];
    const needsReview = applicationNeedsOperatorReview(fields);
    assert.equal(needsReview, false, 'Applications with optional cover letter should not force operator review');
  });
});
