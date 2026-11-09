import { describe, it, expect, vi } from 'vitest';
import {
  activeSubmissions,
  closeSubmissionSession,
  registerSubmissionSession,
  storePausedSession,
  resolvePausedSession,
  clearPausedSession,
} from '../src/submitter/otpSession.js';
import {
  PAUSED_SESSIONS,
  prepareSubmissionPreflight,
} from '../src/submitter/liveSubmit.js';
import { classifyRequiredFieldFailure } from '../src/utils/failureDiagnostics.js';
import { isAshbySubmissionRetryAllowed } from '../src/submitter/submissionRetry.js';
import { buildFailureDiagnostic } from '../src/utils/failureDiagnostics.js';
import { capTelemetryMetadata } from '../src/submitter/ashbySubmit.js';

describe('LiveSubmit Pipeline & Unified OTP Session Registry (PR 7)', () => {
  it('unifies PAUSED_SESSIONS and activeSubmissions on the same Map instance (Remedy 7A)', () => {
    expect(PAUSED_SESSIONS).toBe(activeSubmissions);
  });

  it('stores and resolves paused sessions with aliases and canonical key in the unified registry', async () => {
    const appId = 'app-unified-test-123';
    const applywizzId = 'AWL-UNIFIED-123';
    const mockPage = { isClosed: () => false, close: vi.fn().mockResolvedValue(undefined) } as any;
    const mockBrowser = { close: vi.fn().mockResolvedValue(undefined) } as any;

    const canonicalKey = storePausedSession(
      { id: appId, applywizz_id: applywizzId, job_url: 'https://example.com' } as any,
      {
        browser: mockBrowser,
        page: mockPage,
        applicationId: appId,
        otpFieldSelector: '#otp-code',
      }
    );

    expect(canonicalKey).toBe(appId);
    expect(activeSubmissions.has(appId)).toBe(true);
    expect(PAUSED_SESSIONS.has(appId)).toBe(true);
    expect(PAUSED_SESSIONS.has(applywizzId)).toBe(true);

    const resolved = resolvePausedSession(applywizzId);
    expect(resolved).not.toBeNull();
    expect(resolved?.session.applicationId).toBe(appId);
    expect(resolved?.session.otpFieldSelector).toBe('#otp-code');

    await clearPausedSession(appId, { captureFailureProof: false });
    expect(activeSubmissions.has(appId)).toBe(false);
    expect(PAUSED_SESSIONS.has(applywizzId)).toBe(false);
    expect(mockPage.close).toHaveBeenCalled();
  });

  it('fails fast in prepareSubmissionPreflight when job_url is missing', async () => {
    await expect(
      prepareSubmissionPreflight({ id: 'app-no-url', applywizz_id: 'AWL-001' } as any)
    ).rejects.toThrow(/no job_url/i);
  });

  it('keeps required-choice and DOM-commit failures permanent while preserving transient retry policy', () => {
    expect(classifyRequiredFieldFailure([{ fieldId: 'country', type: 'select', source: 'unresolved', resolvedByTier: null }], ['country']))
      .toBe('RESOLUTION_CHOICE_MISMATCH');
    expect(classifyRequiredFieldFailure([{ fieldId: 'country', source: 'api', resolvedByTier: 4 }], ['country']))
      .toBe('CONTROL_NOT_COMMITTED');

    expect(isAshbySubmissionRetryAllowed({
      success: false,
      status: 'FAILED',
      applicationId: 'app-1',
      errorMessage: 'Pre-submit validation failed: required field uncommitted',
      submitClicked: false,
      telemetry: { stage: 'PRE_SUBMIT', capturedAt: new Date().toISOString() },
    } as any)).toBe(false);
    expect(isAshbySubmissionRetryAllowed({
      success: false,
      status: 'FAILED',
      applicationId: 'app-1',
      errorMessage: 'proxy preflight failed',
      submitClicked: false,
      telemetry: { stage: 'PREFLIGHT', capturedAt: new Date().toISOString() },
    } as any)).toBe(true);
    expect(isAshbySubmissionRetryAllowed({
      success: false,
      status: 'FAILED',
      applicationId: 'app-1',
      errorMessage: 'navigation readiness timed out',
      submitClicked: false,
      telemetry: { stage: 'DOM_SCAN', capturedAt: new Date().toISOString() },
    } as any)).toBe(true);
    expect(isAshbySubmissionRetryAllowed({
      success: false,
      status: 'FAILED',
      applicationId: 'app-1',
      errorMessage: 'captcha detected',
      submitClicked: false,
      telemetry: { stage: 'DOM_SCAN', challengeType: 'turnstile', capturedAt: new Date().toISOString() },
    } as any)).toBe(false);
  });

  it('does not call unresolved text or file fields choice mismatches', () => {
    expect(classifyRequiredFieldFailure([
      { fieldId: 'cover_letter', type: 'textarea', source: 'unresolved', resolvedByTier: null },
    ], ['cover_letter'])).toBe('SUBMIT_REQUIRED_FIELD_EMPTY');
    expect(classifyRequiredFieldFailure([
      { fieldId: 'resume_upload', type: 'file', source: 'unresolved', resolvedByTier: null },
    ], ['resume_upload'])).toBe('SUBMIT_REQUIRED_FIELD_EMPTY');
  });

  it('retains proxy outcome through telemetry capping into a persisted diagnostic row', () => {
    const metadata = capTelemetryMetadata({
      stage: 'PREFLIGHT',
      proxyOutcome: 'country_mismatch',
      failureCategory: 'PROXY_PREFLIGHT',
      errorMessage: 'x'.repeat(3000),
      capturedAt: new Date().toISOString(),
    });
    const diagnostic = buildFailureDiagnostic({
      category: 'PROXY_PREFLIGHT',
      reason: 'Ashby proxy preflight failed',
      isTerminal: false,
      isRetryable: true,
      metadata,
    });
    expect(diagnostic.metadata.proxyOutcome).toBe('country_mismatch');
    expect(diagnostic.metadata.failureCategory).toBe('PROXY_PREFLIGHT');
  });
});
