import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applicationNeedsOperatorReview,
  applicationShouldBeFilteredOut,
} from '../src/resolver/needsReview.js';
import { isOverQuestionCap } from '../src/db/skippedApplications.js';

describe('AI auto-queue execution routing', () => {
  it('auto-queues when all required fields are resolved, including by AI', () => {
    assert.equal(
      applicationNeedsOperatorReview([
        { isRequired: true, source: 'ai', label: 'Custom question', value: 'Answer' },
        { isRequired: true, source: 'supabase', label: 'First name', value: 'Jordan' },
      ]),
      false
    );
  });

  it('keeps unresolved required fields in operator review', () => {
    assert.equal(applicationNeedsOperatorReview([
      { isRequired: true, source: 'unresolved', label: 'Work authorization' },
    ]), true);
  });

  it('keeps required cover letters in operator review', () => {
    assert.equal(applicationNeedsOperatorReview([
      { isRequired: true, source: 'supabase', label: 'Cover Letter', value: '' },
    ]), true);
  });

  it('keeps negative compensation answers in operator review', () => {
    assert.equal(applicationNeedsOperatorReview([
      { isRequired: false, source: 'supabase', label: 'Salary expectation', value: 'No' },
    ]), true);
  });

  it('filters applications with more than three unresolved required fields', () => {
    assert.equal(applicationShouldBeFilteredOut([
      { isRequired: true, source: 'unresolved' },
      { isRequired: true, source: 'unresolved' },
      { isRequired: true, source: 'unresolved' },
      { isRequired: true, source: 'unresolved' },
    ]), true);
  });

  it('does not filter applications for required AI fields alone', () => {
    assert.equal(applicationShouldBeFilteredOut([
      { isRequired: true, source: 'ai' },
      { isRequired: true, source: 'ai' },
      { isRequired: true, source: 'ai' },
      { isRequired: true, source: 'ai' },
    ]), false);
  });

  it('does not skip a large form based on field count', () => {
    assert.equal(isOverQuestionCap(500), false);
  });
});
