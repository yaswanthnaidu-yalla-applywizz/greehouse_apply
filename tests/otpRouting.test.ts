import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeCompanyNameForOtp } from '../src/services/otpResolutionService.js';

describe('OTP Engine: Universal Routing + Company Name Normalization (Phase 2)', () => {
  describe('Company name legal entity normalization', () => {
    it('normalizes BrightAI Corporation to BrightAI', () => {
      expect(normalizeCompanyNameForOtp('BrightAI Corporation')).toBe('BrightAI');
    });

    it('normalizes Take-Two Interactive Software, Inc. to Take-Two', () => {
      expect(normalizeCompanyNameForOtp('Take-Two Interactive Software, Inc.')).toBe('Take-Two');
    });

    it('normalizes EarnIn (Activehours, Inc.) to EarnIn', () => {
      expect(normalizeCompanyNameForOtp('EarnIn (Activehours, Inc.)')).toBe('EarnIn');
    });

    it('normalizes Ceribell, Inc to Ceribell', () => {
      expect(normalizeCompanyNameForOtp('Ceribell, Inc')).toBe('Ceribell');
    });

    it('leaves single-word company unchanged', () => {
      expect(normalizeCompanyNameForOtp('Anthropic')).toBe('Anthropic');
    });

    it('handles empty or undefined company gracefully', () => {
      expect(normalizeCompanyNameForOtp('')).toBe('');
      expect(normalizeCompanyNameForOtp(undefined as any)).toBe('');
    });
  });

  describe('Universal primary routing to Gmail API with Zoho fallback', () => {
    let otpResolutionService: any;

    beforeEach(async () => {
      vi.resetModules();
      const mod = await import('../src/services/otpResolutionService.js');
      otpResolutionService = mod.otpResolutionService;
    });

    it('@applywizard.ai candidate routes to Zoho API first (not Gmail)', async () => {
      const fetchGmailMock = vi.fn();
      const fetchZohoMock = vi.fn().mockResolvedValue({
        success: true,
        otp: '12345678',
        messageId: 'msg-1',
      });

      const service = new otpResolutionService.constructor({
        fetchGmailOtpViaApi: fetchGmailMock,
        fetchZohoOtpViaApi: fetchZohoMock,
        getApplication: vi.fn().mockResolvedValue({
          id: 'app-1',
          applywizz_id: 'AWL-1',
          company_name: 'BrightAI Corporation',
        }),
        updateStatus: vi.fn(),
        resolvePausedSession: vi.fn().mockReturnValue({ page: {} }),
        submitOtpToPausedSession: vi.fn().mockResolvedValue({ success: true }),
        clearPausedSession: vi.fn(),
        sleep: vi.fn(),
      });

      const entry = {
        applicationId: 'app-1',
        sessionKey: 'app-1',
        email: 'test.candidate@applywizard.ai',
        submitClickedAt: Date.now(),
        attemptedCodes: [],
        attemptedMessageIds: [],
      };

      service.register(entry);
      await service.processEntryInContext(entry);

      expect(fetchZohoMock).toHaveBeenCalled();
      expect(fetchZohoMock.mock.calls[0][0].companyName).toBe('BrightAI');
      expect(fetchGmailMock).not.toHaveBeenCalled();
    }, 10000);

    it('@gmail.com candidate routes to Gmail API first', async () => {
      const fetchGmailMock = vi.fn().mockResolvedValue({
        success: true,
        otp: '87654321',
        messageId: 'msg-2',
      });
      const fetchZohoMock = vi.fn();

      const service = new otpResolutionService.constructor({
        fetchGmailOtpViaApi: fetchGmailMock,
        fetchZohoOtpViaApi: fetchZohoMock,
        getApplication: vi.fn().mockResolvedValue({
          id: 'app-2',
          applywizz_id: 'AWL-2',
          company_name: 'Anthropic',
        }),
        updateStatus: vi.fn(),
        resolvePausedSession: vi.fn().mockReturnValue({ page: {} }),
        submitOtpToPausedSession: vi.fn().mockResolvedValue({ success: true }),
        clearPausedSession: vi.fn(),
        sleep: vi.fn(),
      });

      const entry = {
        applicationId: 'app-2',
        sessionKey: 'app-2',
        email: 'test.candidate@gmail.com',
        submitClickedAt: Date.now(),
        attemptedCodes: [],
        attemptedMessageIds: [],
      };

      service.register(entry);
      await service.processEntryInContext(entry);

      expect(fetchGmailMock).toHaveBeenCalled();
      expect(fetchGmailMock.mock.calls[0][0].companyName).toBe('Anthropic');
      expect(fetchZohoMock).not.toHaveBeenCalled();
    }, 10000);

    it('mailbox_not_connected response triggers Zoho fallback', async () => {
      const fetchGmailMock = vi.fn().mockResolvedValue({
        success: false,
        reason: 'mailbox_not_connected',
        reasonCode: 'GMAIL_MAILBOX_NOT_CONNECTED',
      });
      const fetchZohoMock = vi.fn().mockResolvedValue({
        success: true,
        otp: '99999999',
        messageId: 'zoho-msg-1',
      });

      const service = new otpResolutionService.constructor({
        fetchGmailOtpViaApi: fetchGmailMock,
        fetchZohoOtpViaApi: fetchZohoMock,
        getApplication: vi.fn().mockResolvedValue({
          id: 'app-3',
          applywizz_id: 'AWL-3',
          company_name: 'Ceribell, Inc',
        }),
        updateStatus: vi.fn(),
        resolvePausedSession: vi.fn().mockReturnValue({ page: {} }),
        submitOtpToPausedSession: vi.fn().mockResolvedValue({ success: true }),
        clearPausedSession: vi.fn(),
        sleep: vi.fn(),
      });

      const entry = {
        applicationId: 'app-3',
        sessionKey: 'app-3',
        email: 'unconnected@gmail.com',
        submitClickedAt: Date.now(),
        attemptedCodes: [],
        attemptedMessageIds: [],
      };

      service.register(entry);
      await service.processEntryInContext(entry);

      expect(fetchGmailMock).toHaveBeenCalled();
      expect(fetchZohoMock).toHaveBeenCalled();
    });

    it('not_yet response triggers fallback to Zoho provider', async () => {
      const fetchGmailMock = vi.fn().mockResolvedValue({
        success: false,
        reason: 'not_yet',
        reasonCode: 'GMAIL_OTP_NOT_YET',
      });
      const fetchZohoMock = vi.fn().mockResolvedValue({
        success: true,
        otp: '11223344',
        messageId: 'msg-final',
      });

      const service = new otpResolutionService.constructor({
        fetchGmailOtpViaApi: fetchGmailMock,
        fetchZohoOtpViaApi: fetchZohoMock,
        getApplication: vi.fn().mockResolvedValue({
          id: 'app-4',
          applywizz_id: 'AWL-4',
          company_name: 'EarnIn (Activehours, Inc.)',
        }),
        updateStatus: vi.fn(),
        resolvePausedSession: vi.fn().mockReturnValue({ page: {} }),
        submitOtpToPausedSession: vi.fn().mockResolvedValue({ success: true }),
        clearPausedSession: vi.fn(),
        sleep: vi.fn(),
      });

      const entry = {
        applicationId: 'app-4',
        sessionKey: 'app-4',
        email: 'test@gmail.com',
        submitClickedAt: Date.now(),
        attemptedCodes: [],
        attemptedMessageIds: [],
      };

      service.register(entry);
      await service.processEntryInContext(entry);

      expect(fetchGmailMock).toHaveBeenCalled();
      expect(fetchZohoMock).toHaveBeenCalled();
    });
  });

  describe('OTP challenge and timeout screenshots', () => {
    it('captures OTP challenge screenshot when detectOTPField returns true', async () => {
      const { captureJobOtpScreenshot } = await import('../src/submitter/proofCapture.js');
      const mockPage = {
        isClosed: vi.fn().mockReturnValue(false),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
        screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
      };

      const result = await captureJobOtpScreenshot(mockPage as any, 'app-otp-test');
      expect(result.url).toContain('app-otp-test_otp_challenge.png');
    });

    it('captures timeout screenshot before browser close on budget exhaustion', async () => {
      const { captureJobFailedScreenshot } = await import('../src/submitter/proofCapture.js');
      const mockPage = {
        isClosed: vi.fn().mockReturnValue(false),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
        screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
      };

      const result = await captureJobFailedScreenshot(mockPage as any, 'app-otp-fail', 'otp_timeout');
      expect(result.url).toContain('app-otp-fail_failed_otp_timeout.png');
    });
  });
});
