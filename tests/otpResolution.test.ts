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
      const submitClickedAt = virtualTime; // deadline = virtualTime + 480,000

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
          virtualTime += 100000; // Advance 100s per sleep to cover the 480s budget.
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

  it('does not start a mailbox poll when less than one full interval remains', async () => {
    let virtualTime = 1000000;
    const realNow = Date.now;
    const submitClickedAt = virtualTime - OTP_CHALLENGE_TIMEOUT_MS + 3000;
    let pollCount = 0;

    Date.now = () => virtualTime;
    try {
      const svc = new OtpResolutionService({
        getApplication: async () =>
          ({
            id: 'app-final-poll-window',
            applywizz_id: 'AWL-5A',
            job_url: 'https://gh.io/job5a',
            status: 'OTP_REQUIRED',
            retry_count: 0,
          } as ApplicationRow),
        updateStatus: async () => true,
        resolvePausedSession: () => ({ session: {} as any, canonicalKey: 'session-final-poll-window' }),
        fetchZohoOtpViaApi: async () => {
          pollCount++;
          virtualTime = submitClickedAt + OTP_CHALLENGE_TIMEOUT_MS;
          return { success: false, reasonCode: 'POLL_BUDGET_EXHAUSTED' };
        },
        clearPausedSession: async () => {},
        sleep: async () => {},
      });
      const entry: OtpPendingEntry = {
        applicationId: 'app-final-poll-window',
        email: 'test@applywizard.ai',
        submitClickedAt,
        sessionKey: 'session-final-poll-window',
        claimed: false,
        attemptedMessageIds: [],
        attemptedCodes: [],
      };

      svc.register(entry);
      await svc.processEntryInContext(entry);

      assert.equal(pollCount, 0, 'a poll must not start when less than 10 seconds remain');
    } finally {
      Date.now = realNow;
    }
  });

  it('test: budget exhaustion triggers QUEUED status with retry_count++', async () => {
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

    assert.equal(finalStatus, 'QUEUED', 'Budget exhaustion must trigger QUEUED status before the retry limit');
    assert.equal(finalRetryCount, 2, 'retry_count must be incremented from 1 to 2');
    assert.ok(
      finalErrorMessage && finalErrorMessage.includes('480s'),
      'error_message must describe the 480s timeout'
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

  it('test: OTP_REQUIRED never persists after 480s budget', async () => {
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
      'OTP_REQUIRED must never be the resting state after 480s budget'
    );
    assert.equal(recordedStatus, 'QUEUED', 'Budget exhaustion should queue a retry before the retry limit');
  });

  it('test: budget exhaustion fails immediately as FAILED when candidate mailbox is NOT connected', async () => {
    let recordedStatus: string | null = null;
    let recordedErrorMessage: string | null = null;
    const submitClickedAt = Date.now() - (OTP_CHALLENGE_TIMEOUT_MS + 1000);

    const svc = new OtpResolutionService({
      getApplication: async () =>
        ({
          id: 'app-mailbox-disconnected',
          applywizz_id: 'AWL-DISCONNECTED',
          job_url: 'https://gh.io/job-disconnected',
          status: 'OTP_REQUIRED',
          retry_count: 0,
        } as ApplicationRow),
      getProfile: async () =>
        ({
          applywizz_id: 'AWL-DISCONNECTED',
          client_name: 'Disconnected Candidate',
          zoho_connected: false,
        } as any),
      updateStatus: async (_id, status, extra) => {
        recordedStatus = status;
        recordedErrorMessage = extra?.error_message ?? null;
        return true;
      },
      resolvePausedSession: () => ({ session: {} as any, canonicalKey: 'session-disconnected' }),
      fetchZohoOtpViaApi: async () => ({ success: false }),
      clearPausedSession: async () => {},
      sleep: async () => {},
    });

    const entry: OtpPendingEntry = {
      applicationId: 'app-mailbox-disconnected',
      email: 'disconnected@applywizard.ai',
      submitClickedAt,
      sessionKey: 'session-disconnected',
      claimed: false,
      attemptedMessageIds: [],
      attemptedCodes: [],
    };
    svc.register(entry);
    await svc.processEntryInContext(entry);

    assert.equal(recordedStatus, 'FAILED', 'Must transition to terminal FAILED if mailbox is not connected');
    assert.ok(
      recordedErrorMessage && recordedErrorMessage.includes('mailbox is disconnected'),
      'Error message must state candidate mailbox is disconnected'
    );
  });

  it('test: MAILBOX_NOT_CONFIGURED immediately terminates session without polling 480s', async () => {
    let recordedStatus: string | null = null;
    let recordedErrorMessage: string | null = null;
    let sessionCleared = false;
    let pollAttempts = 0;

    const svc = new OtpResolutionService({
      getApplication: async () =>
        ({
          id: 'app-unconfigured',
          applywizz_id: 'AWL-UNCONFIGURED',
          job_url: 'https://gh.io/job-unconfigured',
          status: 'OTP_REQUIRED',
          retry_count: 0,
        } as ApplicationRow),
      updateStatus: async (_id, status, extra) => {
        recordedStatus = status;
        recordedErrorMessage = extra?.error_message ?? null;
        return true;
      },
      resolvePausedSession: () => ({ session: {} as any, canonicalKey: 'session-unconfigured' }),
      fetchZohoOtpViaApi: async () => {
        pollAttempts++;
        return {
          success: false,
          reason: 'mailbox not configured',
          reasonCode: 'MAILBOX_NOT_CONFIGURED',
          errorMessage: 'Candidate mailbox is not configured upstream.',
        };
      },
      clearPausedSession: async () => {
        sessionCleared = true;
      },
      sleep: async () => {},
    });

    const entry: OtpPendingEntry = {
      applicationId: 'app-unconfigured',
      email: 'unconfigured@applywizard.ai',
      submitClickedAt: Date.now(),
      sessionKey: 'session-unconfigured',
      claimed: false,
      attemptedMessageIds: [],
      attemptedCodes: [],
    };
    svc.register(entry);
    await svc.processEntryInContext(entry);

    assert.equal(pollAttempts, 1, 'Must abort immediately after 1 attempt when mailbox is not configured');
    assert.equal(sessionCleared, true, 'Must clear paused session');
    assert.equal(recordedStatus, 'FAILED', 'Must transition to terminal FAILED status');
    assert.ok(recordedErrorMessage?.includes('MAILBOX_NOT_CONFIGURED'), 'Error message must specify MAILBOX_NOT_CONFIGURED');
  });

  it('test: budget exhaustion requeues to QUEUED when candidate mailbox is connected and under retry limit', async () => {
    let recordedStatus: string | null = null;
    let recordedRetryCount: number | null = null;
    const submitClickedAt = Date.now() - (OTP_CHALLENGE_TIMEOUT_MS + 1000);

    const svc = new OtpResolutionService({
      getApplication: async () =>
        ({
          id: 'app-mailbox-connected',
          applywizz_id: 'AWL-CONNECTED',
          job_url: 'https://gh.io/job-connected',
          status: 'OTP_REQUIRED',
          retry_count: 1,
        } as ApplicationRow),
      getProfile: async () =>
        ({
          applywizz_id: 'AWL-CONNECTED',
          client_name: 'Connected Candidate',
          zoho_connected: true,
        } as any),
      updateStatus: async (_id, status, extra) => {
        recordedStatus = status;
        recordedRetryCount = extra?.retry_count ?? null;
        return true;
      },
      resolvePausedSession: () => ({ session: {} as any, canonicalKey: 'session-connected' }),
      fetchZohoOtpViaApi: async () => ({ success: false }),
      clearPausedSession: async () => {},
      sleep: async () => {},
    });

    const entry: OtpPendingEntry = {
      applicationId: 'app-mailbox-connected',
      email: 'connected@applywizard.ai',
      submitClickedAt,
      sessionKey: 'session-connected',
      claimed: false,
      attemptedMessageIds: [],
      attemptedCodes: [],
    };
    svc.register(entry);
    await svc.processEntryInContext(entry);

    assert.equal(recordedStatus, 'QUEUED', 'Must requeue to QUEUED when mailbox is connected');
    assert.equal(recordedRetryCount, 2, 'retry_count must be incremented to 2');
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
