import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeOperatorErrorMessage,
  OperatorErrors,
} from '../src/operator/operatorErrorMessages.js';

describe('operatorErrorMessages', () => {
  it('maps question-cap jargon to operator copy', () => {
    assert.equal(
      normalizeOperatorErrorMessage('Skipped: 46 form fields (>= 35)', 'SKIPPED'),
      OperatorErrors.TOO_MANY_QUESTIONS
    );
  });

  it('maps Zoho and profile failures', () => {
    assert.equal(
      normalizeOperatorErrorMessage('Candidate AWL-1 is not Zoho Mail connected'),
      OperatorErrors.ZOHO_NOT_CONNECTED
    );
    assert.equal(
      normalizeOperatorErrorMessage('ApplyWizz profile was not written to Supabase profiles'),
      OperatorErrors.PROFILE_NOT_RETRIEVED
    );
  });

  it('maps scan and network failures', () => {
    assert.equal(
      normalizeOperatorErrorMessage('Playwright failed to scan — timeout'),
      OperatorErrors.SCAN_FAILED
    );
    assert.equal(normalizeOperatorErrorMessage('fetch failed ECONNREFUSED'), OperatorErrors.NETWORK);
  });

  it('maps submission timeout jargon', () => {
    assert.equal(
      normalizeOperatorErrorMessage('Form submission timed out', 'FAILED'),
      OperatorErrors.VERIFICATION_TIMEOUT
    );
  });

  it('preserves already-friendly copy', () => {
    const friendly = OperatorErrors.TOO_MANY_QUESTIONS;
    assert.equal(normalizeOperatorErrorMessage(friendly, 'SKIPPED'), friendly);
  });
});
