import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  resolveOtpEndpoint,
  OtpResolutionService,
  OTP_CHALLENGE_TIMEOUT_MS,
  type OtpPendingEntry,
} from '../src/services/otpResolutionService.js';
import { TokenBucketLimiter } from '../src/services/mailboxRateLimiter.js';
import type { ApplicationRow } from '../src/db/applications.js';

describe('Phase 2: OTP Engine: Premature Break + Domain Routing + Rate Limiting', () => {
  beforeEach(() => {
    process.env.SANDBOX = 'true';
  });

  it('test: @applywizard.ai routes exclusively to zoho endpoint', async () => {
    assert.equal(resolveOtpEndpoint('user@applywizard.ai'), 'zoho');
    assert.equal(resolveOtpEndpoint('JOHN.DOE@APPLYWIZARD.AI'), 'zoho');

    let zohoCalled = 0;
    let gmailCalled = 0;

    const svc = new OtpResolutionService({
      getApplication: async () =>
        ({
          id: 'app-zoho',
          applywizz_id: 'AWL-1',
          job_url: 'https://gh.io/job1',
          status: 'OTP_REQUIRED',
          retry_count: 0,
        } as ApplicationRow),
      updateStatus: async () => true,
      resolvePausedSession: () => ({ session: {} as any, canonicalKey: 'session-1' }),
      fetchZohoOtpViaApi: async () => {
        zohoCalled++;
        return { success: true, otp: '654321', messageId: 'z-msg-1' };
      },
      fetchGmailOtpViaApi: async () => {
        gmailCalled++;
        return { success: false, reasonCode: 'WRONG_ENDPOINT' };
      },
      submitOtpToPausedSession: async () => ({ success: true, status: 'APPLIED' }),
      clearPausedSession: async () => {},
      sleep: async () => {},
    });

    const entry: OtpPendingEntry = {
      applicationId: 'app-zoho',
      email: 'candidate@applywizard.ai',
      submitClickedAt: Date.now(),
      sessionKey: 'session-1',
      claimed: false,
      attemptedMessageIds: [],
      attemptedCodes: [],
    };
    svc.register(entry);
    await svc.processEntryInContext(entry);

    assert.equal(zohoCalled, 1, 'Zoho endpoint must be called for @applywizard.ai');
    assert.equal(gmailCalled, 0, 'Gmail endpoint must NEVER be called for @applywizard.ai');
  });

  it('test: @gmail.com routes exclusively to gmail endpoint', async () => {
    assert.equal(resolveOtpEndpoint('user@gmail.com'), 'gmail');
    assert.equal(resolveOtpEndpoint('JANE.DOE@GMAIL.COM'), 'gmail');

    let zohoCalled = 0;
    let gmailCalled = 0;

    const svc = new OtpResolutionService({
      getApplication: async () =>
        ({
          id: 'app-gmail',
          applywizz_id: 'AWL-2',
          job_url: 'https://gh.io/job2',
          status: 'OTP_REQUIRED',
          retry_count: 0,
        } as ApplicationRow),
      updateStatus: async () => true,
      resolvePausedSession: () => ({ session: {} as any, canonicalKey: 'session-2' }),
      fetchZohoOtpViaApi: async () => {
        zohoCalled++;
        return { success: false, reasonCode: 'WRONG_ENDPOINT' };
      },
      fetchGmailOtpViaApi: async () => {
        gmailCalled++;
        return { success: true, otp: '112233', messageId: 'g-msg-1' };
      },
      submitOtpToPausedSession: async () => ({ success: true, status: 'APPLIED' }),
      clearPausedSession: async () => {},
      sleep: async () => {},
    });

    const entry: OtpPendingEntry = {
      applicationId: 'app-gmail',
      email: 'candidate@gmail.com',
      submitClickedAt: Date.now(),
      sessionKey: 'session-2',
      claimed: false,
      attemptedMessageIds: [],
      attemptedCodes: [],
    };
    svc.register(entry);
    await svc.processEntryInContext(entry);

    assert.equal(gmailCalled, 1, 'Gmail endpoint must be called for @gmail.com');
    assert.equal(zohoCalled, 0, 'Zoho endpoint must NEVER be called for @gmail.com');
  });

  it('test: poll loop does NOT break on first not_yet — continues until deadline', async () => {
    let pollCount = 0;
    let sleepCount = 0;
    const realNow = Date.now;
    let virtualTime = 1000000;
    Date.now = () => virtualTime;

    try {
      const submitClickedAt = virtualTime; // deadline = virtualTime + 300,000

      const svc = new OtpResolutionService({
        getApplication: async () =>
          ({
            id: 'app-loop',
            applywizz_id: 'AWL-3',
            job_url: 'https://gh.io/job3',
            status: 'OTP_REQUIRED',
            retry_count: 0,
          } as ApplicationRow),
        updateStatus: async () => true,
        resolvePausedSession: () => ({ session: {} as any, canonicalKey: 'session-3' }),
        fetchZohoOtpViaApi: async () => {
          pollCount++;
          return { success: false, reasonCode: 'NO_MATCHING_OTP_EMAIL' };
        },
        clearPausedSession: async () => {},
        sleep: async () => {
          sleepCount++;
          virtualTime += 100000; // advance 100s per sleep, so 3 sleeps exhaust the 300s budget
        },
      });

      const entry: OtpPendingEntry = {
        applicationId: 'app-loop',
        email: 'test@applywizard.ai',
        submitClickedAt,
        sessionKey: 'session-3',
        claimed: false,
        attemptedMessageIds: [],
        attemptedCodes: [],
      };
      svc.register(entry);
      await svc.processEntryInContext(entry);

      assert.ok(pollCount > 1, `Poll loop must continue polling instead of breaking on first not_yet (polled ${pollCount} times)`);
      assert.ok(sleepCount > 0, `Poll loop must sleep between attempts`);
    } finally {
      Date.now = realNow;
    }
  });

  it('test: poll loop exits early when code received at t=45s', async () => {
    let pollCount = 0;
    const svc = new OtpResolutionService({
      getApplication: async () =>
        ({
          id: 'app-early',
          applywizz_id: 'AWL-4',
          job_url: 'https://gh.io/job4',
          status: 'OTP_REQUIRED',
          retry_count: 0,
        } as ApplicationRow),
      updateStatus: async () => true,
      resolvePausedSession: () => ({ session: {} as any, canonicalKey: 'session-4' }),
      fetchZohoOtpViaApi: async () => {
        pollCount++;
        if (pollCount === 2) {
          return { success: true, otp: '998877', messageId: 'msg-hit' };
        }
        return { success: false, reasonCode: 'NO_MATCHING_OTP_EMAIL' };
      },
      submitOtpToPausedSession: async () => ({ success: true, status: 'APPLIED' }),
      clearPausedSession: async () => {},
      sleep: async () => {},
    });

    const entry: OtpPendingEntry = {
      applicationId: 'app-early',
      email: 'test@applywizard.ai',
      submitClickedAt: Date.now(),
      sessionKey: 'session-4',
      claimed: false,
      attemptedMessageIds: [],
      attemptedCodes: [],
    };
    svc.register(entry);
    await svc.processEntryInContext(entry);

    assert.equal(pollCount, 2, 'Poll loop must exit early once code is resolved (expected 2 calls, got ' + pollCount + ')');
  });

  it('test: budget exhaustion triggers RETRY status with retry_count++', async () => {
    let finalStatus: string | null = null;
    let finalRetryCount: number | null = null;
    let finalErrorMessage: string | null = null;

    // Set submitClickedAt in past so deadline is immediately reached
    const submitClickedAt = Date.now() - (OTP_CHALLENGE_TIMEOUT_MS + 1000);

    const svc = new OtpResolutionService({
      getApplication: async () =>
        ({
          id: 'app-timeout',
          applywizz_id: 'AWL-5',
          job_url: 'https://gh.io/job5',
          status: 'OTP_REQUIRED',
          retry_count: 1,
        } as ApplicationRow),
      updateStatus: async (_id, status, extra) => {
        finalStatus = status;
        finalRetryCount = extra?.retry_count ?? null;
        finalErrorMessage = extra?.error_message ?? null;
        return true;
      },
      resolvePausedSession: () => ({ session: {} as any, canonicalKey: 'session-5' }),
      fetchZohoOtpViaApi: async () => ({ success: false, reasonCode: 'TIMEOUT' }),
      clearPausedSession: async () => {},
      sleep: async () => {},
    });

    const entry: OtpPendingEntry = {
      applicationId: 'app-timeout',
      email: 'test@applywizard.ai',
      submitClickedAt,
      sessionKey: 'session-5',
      claimed: false,
      attemptedMessageIds: [],
      attemptedCodes: [],
    };
    svc.register(entry);
    await svc.processEntryInContext(entry);

    assert.equal(finalStatus, 'RETRY', 'Budget exhaustion must trigger RETRY status');
    assert.equal(finalRetryCount, 2, 'retry_count must be incremented from 1 to 2');
    assert.ok(
      finalErrorMessage && finalErrorMessage.includes('300s'),
      'error_message must describe 300s timeout'
    );
  });

  it('test: budget exhaustion triggers clearPausedSession()', async () => {
    let sessionCleared = false;
    let clearedKey: string | null = null;

    const submitClickedAt = Date.now() - (OTP_CHALLENGE_TIMEOUT_MS + 1000);

    const svc = new OtpResolutionService({
      getApplication: async () =>
        ({
          id: 'app-clear',
          applywizz_id: 'AWL-6',
          job_url: 'https://gh.io/job6',
          status: 'OTP_REQUIRED',
          retry_count: 0,
        } as ApplicationRow),
      updateStatus: async () => true,
      resolvePausedSession: () => ({ session: {} as any, canonicalKey: 'session-6' }),
      fetchZohoOtpViaApi: async () => ({ success: false, reasonCode: 'TIMEOUT' }),
      clearPausedSession: async (key) => {
        sessionCleared = true;
        clearedKey = key;
      },
      sleep: async () => {},
    });

    const entry: OtpPendingEntry = {
      applicationId: 'app-clear',
      email: 'test@applywizard.ai',
      submitClickedAt,
      sessionKey: 'session-6',
      claimed: false,
      attemptedMessageIds: [],
      attemptedCodes: [],
    };
    svc.register(entry);
    await svc.processEntryInContext(entry);

    assert.equal(sessionCleared, true, 'clearPausedSession must be called on budget exhaustion');
    assert.equal(clearedKey, 'session-6', 'cleared session key must match entry.sessionKey');
  });

  it('test: OTP_REQUIRED never persists after 300s budget', async () => {
    let recordedStatus: string | null = null;
    const submitClickedAt = Date.now() - (OTP_CHALLENGE_TIMEOUT_MS + 1000);

    const svc = new OtpResolutionService({
      getApplication: async () =>
        ({
          id: 'app-no-otp-req',
          applywizz_id: 'AWL-7',
          job_url: 'https://gh.io/job7',
          status: 'OTP_REQUIRED',
          retry_count: 0,
        } as ApplicationRow),
      updateStatus: async (_id, status) => {
        recordedStatus = status;
        return true;
      },
      resolvePausedSession: () => ({ session: {} as any, canonicalKey: 'session-7' }),
      fetchZohoOtpViaApi: async () => ({ success: false }),
      clearPausedSession: async () => {},
      sleep: async () => {},
    });

    const entry: OtpPendingEntry = {
      applicationId: 'app-no-otp-req',
      email: 'test@applywizard.ai',
      submitClickedAt,
      sessionKey: 'session-7',
      claimed: false,
      attemptedMessageIds: [],
      attemptedCodes: [],
    };
    svc.register(entry);
    await svc.processEntryInContext(entry);

    assert.notEqual(
      recordedStatus,
      'OTP_REQUIRED',
      'OTP_REQUIRED must never be the resting state after 300s budget'
    );
    assert.equal(recordedStatus, 'RETRY', 'Resting status should be RETRY');
  });

  it('test: token bucket allows max 3 requests/sec across concurrent callers', async () => {
    const limiter = new TokenBucketLimiter(3, 3);
    const start = Date.now();

    // First 3 acquires should happen immediately (within 20ms)
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    const durationFirst3 = Date.now() - start;
    assert.ok(durationFirst3 < 50, `First 3 acquisitions must be instant (took ${durationFirst3}ms)`);

    assert.ok(
      limiter.getAvailableTokens() < 1,
      'Tokens must be exhausted after 3 immediate acquisitions'
    );
  });

  it('test: token bucket queues (not drops) requests when bucket empty', async () => {
    const limiter = new TokenBucketLimiter(3, 3);

    // Consume the 3 available tokens
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    // Now bucket is empty. Launch 2 concurrent acquires that should queue
    let resolvedCount = 0;
    const p1 = limiter.acquire().then(() => {
      resolvedCount++;
    });
    const p2 = limiter.acquire().then(() => {
      resolvedCount++;
    });

    assert.equal(limiter.getQueueLength(), 2, '2 requests must be queued waiting for refill');
    assert.equal(resolvedCount, 0, 'Queued requests must not resolve immediately');

    // Wait for refill and resolution
    await Promise.all([p1, p2]);
    assert.equal(resolvedCount, 2, 'All queued requests must eventually resolve without being dropped');
  });
});
