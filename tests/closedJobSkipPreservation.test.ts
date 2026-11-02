import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldCapturePreCloseFailureScreenshot } from '../src/submitter/liveSubmit.js';

test('shouldCapturePreCloseFailureScreenshot does not overwrite SKIPPED status', () => {
  assert.equal(shouldCapturePreCloseFailureScreenshot('SKIPPED', false), false);
  assert.equal(shouldCapturePreCloseFailureScreenshot('APPLIED', false), false);
  assert.equal(shouldCapturePreCloseFailureScreenshot('EMAIL_PROOF_PENDING', false), false);
  assert.equal(shouldCapturePreCloseFailureScreenshot('OTP_REQUIRED', false), false);
  assert.equal(shouldCapturePreCloseFailureScreenshot('FAILED', false), true);
  assert.equal(shouldCapturePreCloseFailureScreenshot('FAILED', true), false);
  assert.equal(shouldCapturePreCloseFailureScreenshot(null, false), true);
  assert.equal(shouldCapturePreCloseFailureScreenshot(undefined, false), true);
});
