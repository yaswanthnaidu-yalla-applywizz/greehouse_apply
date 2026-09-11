/**
 * @fileoverview Zoho Mail Reader Service for automated OTP extraction (Phase 1).
 *
 * Interacts with https://zoho-mail-reader.onrender.com/ via a persistent Playwright browser:
 * 1. Launches and maintains a persistent background session
 * 2. Authenticates with ZOHO_CONNECTOR_USER & ZOHO_CONNECTOR_PASS
 * 3. Filters candidates by company email (e.g. *@applywizard.ai)
 * 4. Polls incoming messages for Greenhouse / Security Code verification emails
 * 5. Extracts the alphanumeric OTP and returns it for auto-filling
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { config } from '../config/env.js';
import type { EmailProofJson } from '../db/applications.js';

export interface ZohoOtpResult {
  success: boolean;
  otp?: string;
  subject?: string;
  receivedAt?: string;
  errorMessage?: string;
}

export function parseZohoEmailTimestamp(
  whenText: string,
  whenTitle?: string,
  referenceDate: Date = new Date()
): number | null {
  if (whenTitle) {
    const titleClean = whenTitle.replace(/[·📎]/g, ' ').replace(/\s+/g, ' ').trim();
    const titleParsed = Date.parse(titleClean);
    if (!Number.isNaN(titleParsed) && titleParsed > 0) {
      return titleParsed;
    }
  }

  if (!whenText) return null;
  const clean = whenText.replace(/[·📎]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;

  // 1. Direct parse
  const direct = Date.parse(clean);
  if (!Number.isNaN(direct) && direct > 0) {
    const d = new Date(direct);
    if (d.getFullYear() < 2000) {
      d.setFullYear(referenceDate.getFullYear());
      return d.getTime();
    }
    return direct;
  }

  // 2. Format: "Today, 11:25 AM" or "Today 11:25 AM"
  const todayMatch = clean.match(/today(?:,\s*|\s+)(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (todayMatch) {
    let hours = parseInt(todayMatch[1], 10);
    const minutes = parseInt(todayMatch[2], 10);
    const seconds = todayMatch[3] ? parseInt(todayMatch[3], 10) : 0;
    const meridian = (todayMatch[4] || '').toLowerCase();
    if (meridian === 'pm' && hours < 12) hours += 12;
    if (meridian === 'am' && hours === 12) hours = 0;

    const d = new Date(referenceDate);
    d.setHours(hours, minutes, seconds, 0);
    return d.getTime();
  }

  // 3. Format: "Yesterday, 3:45 PM"
  const yesterdayMatch = clean.match(/yesterday(?:,\s*|\s+)(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (yesterdayMatch) {
    let hours = parseInt(yesterdayMatch[1], 10);
    const minutes = parseInt(yesterdayMatch[2], 10);
    const seconds = yesterdayMatch[3] ? parseInt(yesterdayMatch[3], 10) : 0;
    const meridian = (yesterdayMatch[4] || '').toLowerCase();
    if (meridian === 'pm' && hours < 12) hours += 12;
    if (meridian === 'am' && hours === 12) hours = 0;

    const d = new Date(referenceDate.getTime() - 24 * 60 * 60 * 1000);
    d.setHours(hours, minutes, seconds, 0);
    return d.getTime();
  }

  // 4. Format: Plain time e.g. "11:25 AM"
  const timeMatch = clean.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const seconds = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
    const meridian = (timeMatch[4] || '').toLowerCase();
    if (meridian === 'pm' && hours < 12) hours += 12;
    if (meridian === 'am' && hours === 12) hours = 0;

    const d = new Date(referenceDate);
    d.setHours(hours, minutes, seconds, 0);
    return d.getTime();
  }

  // 5. Month Day: "11 Sep" or "Sep 11"
  const monthDayMatch = clean.match(/^([a-zA-Z]{3,9})\s+(\d{1,2})$/) || clean.match(/^(\d{1,2})\s+([a-zA-Z]{3,9})$/);
  if (monthDayMatch) {
    const withYear = `${clean}, ${referenceDate.getFullYear()}`;
    const p = Date.parse(withYear);
    if (!Number.isNaN(p)) return p;
  }

  return null;
}

export function normalizeCompanySearchTerm(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|technologies|tech|solutions|systems|co|gmbh|sa|bv|holdings|group)\b/gi, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchCompanyInEmail(targetCompany: string, from: string, subject: string, body: string): boolean {
  if (!targetCompany) return false;
  const normTarget = normalizeCompanySearchTerm(targetCompany);
  if (!normTarget || normTarget.length < 2) return false;

  const combined = `${from} ${subject} ${body}`.toLowerCase();
  const normCombined = normalizeCompanySearchTerm(combined);

  if (normCombined.includes(normTarget) || combined.includes(normTarget)) {
    return true;
  }

  const tokens = normTarget.split(/\s+/).filter((t) => t.length >= 3);
  if (tokens.length > 0 && tokens.every((t) => combined.includes(t))) {
    return true;
  }

  const fromDomainMatch = from.match(/@([a-z0-9.-]+)/i);
  if (fromDomainMatch) {
    const domain = fromDomainMatch[1].toLowerCase();
    if (tokens.some((t) => domain.includes(t))) {
      return true;
    }
  }

  return false;
}

export function matchConfirmationContent(subject: string, body: string): boolean {
  const combined = `${subject} ${body}`.toLowerCase();
  return (
    combined.includes('thank you for applying') ||
    combined.includes('thanks for applying') ||
    combined.includes('thank you for your application') ||
    combined.includes('thanks for your application') ||
    combined.includes('we received your application') ||
    combined.includes('we have received your application') ||
    combined.includes('application received') ||
    combined.includes('your application has been submitted') ||
    combined.includes('application submitted') ||
    combined.includes('confirming your application') ||
    combined.includes('application confirmation') ||
    combined.includes('application to') ||
    combined.includes('applied to')
  );
}

class ZohoReaderService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private isInitializing: Promise<void> | null = null;
  private isBusy: boolean = false;
  private queue: Array<() => void> = [];

  /**
   * Releases DOM memory by navigating to a blank page when idle.
   */
  public async idlePage(): Promise<void> {
    try {
      if (this.page && !this.page.isClosed()) {
        await this.page.goto('about:blank', { timeout: 5000 }).catch(() => {});
      }
    } catch {}
  }

  /**
   * Initializes the persistent Zoho Reader browser session and performs login if needed.
   */
  public async init(): Promise<void> {
    if (this.page && !this.page.isClosed()) {
      if (this.page.url() === 'about:blank') {
        try {
          await this.page.goto(config.ZOHO_CONNECTOR_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
        } catch {}
      }
      return;
    }

    if (this.isInitializing) {
      return this.isInitializing;
    }

    this.isInitializing = this.setupSession();
    try {
      await this.isInitializing;
    } finally {
      this.isInitializing = null;
    }
  }

  private async setupSession(): Promise<void> {
    const url = config.ZOHO_CONNECTOR_URL;
    const user = config.ZOHO_CONNECTOR_USER;
    const pass = config.ZOHO_CONNECTOR_PASS;

    if (!user || !pass) {
      console.warn('[Zoho Reader] ⚠️ ZOHO_CONNECTOR_USER or ZOHO_CONNECTOR_PASS is missing in environment.');
      return;
    }

    console.log(`[Zoho Reader] 🚀 Launching background session for ${url}...`);

    try {
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      });

      this.context = await this.browser.newContext({
        viewport: { width: 1366, height: 768 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });

      this.page = await this.context.newPage();

      await this.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      // Check if sign-in form is present
      await this.performLoginIfNeeded(user, pass);
      console.log('[Zoho Reader] ✅ Session ready and authenticated.');
    } catch (err: any) {
      console.error(`[Zoho Reader] ❌ Failed to setup session: ${err.message}`);
      await this.cleanup();
      throw err;
    }
  }

  private async performLoginIfNeeded(user: string, pass: string): Promise<void> {
    if (!this.page) return;

    // Look for sign in header or inputs
    const usernameInput = this.page.locator('input[placeholder*="Username" i], input[name*="user" i], input[type="text"]').first();
    const passwordInput = this.page.locator('input[placeholder*="Password" i], input[name*="pass" i], input[type="password"]').first();
    const continueBtn = this.page.locator('button:has-text("Continue"), button[type="submit"]').first();

    const hasUsername = (await usernameInput.count()) > 0 && (await usernameInput.isVisible().catch(() => false));

    if (hasUsername) {
      console.log('[Zoho Reader] 🔑 Detected Sign-In form. Logging in...');
      await usernameInput.fill(user);
      await passwordInput.fill(pass);
      await continueBtn.click();

      // Wait for Mailbox connector dashboard to load
      await this.page.waitForSelector('text=Mailbox connector', { timeout: 30000 }).catch(async () => {
        // Fallback: wait for filter input or users header
        await this.page?.waitForSelector('input[placeholder*="Filter by email" i]', { timeout: 30000 });
      });
    } else {
      console.log('[Zoho Reader] ℹ️ Sign-In form not present; assuming already on dashboard.');
    }

    // Wait until Filter input is visible
    await this.page.waitForSelector('input[placeholder*="Filter by email" i]', { timeout: 20000 });
  }

  /**
   * Serializes requests using a queue so concurrent live submits don't collide on the single page.
   */
  private async acquireLock(): Promise<() => void> {
    if (!this.isBusy) {
      this.isBusy = true;
      return () => this.releaseLock();
    }

    return new Promise((resolve) => {
      this.queue.push(() => {
        this.isBusy = true;
        resolve(() => this.releaseLock());
      });
    });
  }

  private releaseLock(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    } else {
      this.isBusy = false;
    }
  }

  /**
   * Fetches the latest OTP for a candidate by reading emails in Zoho Reader.
   *
   * @param candidateEmail - Candidate's company email (e.g. `user@applywizard.ai`)
   * @param options - Polling timeout and cutoff timestamp
   */
  public async fetchLatestOtp(
    candidateEmail: string,
    options: { timeoutMs?: number; sinceTimestamp?: number } = {}
  ): Promise<ZohoOtpResult> {
    const timeoutMs = options.timeoutMs ?? config.ZOHO_CONNECTOR_TIMEOUT_MS ?? 120000;
    const sinceTimestamp = options.sinceTimestamp ?? (Date.now() - 3 * 60 * 1000);
    const normalizedEmail = candidateEmail.trim().toLowerCase();

    if (!normalizedEmail) {
      return { success: false, errorMessage: 'Candidate email is required for Zoho OTP lookup.' };
    }

    const release = await this.acquireLock();
    try {
      await this.init();
      if (!this.page || this.page.isClosed()) {
        throw new Error('Zoho Reader page is unavailable.');
      }

      console.log(`[Zoho Reader] 🔍 Looking up inbox for candidate: ${normalizedEmail}`);

      // 1. Filter by email in the search input
      const filterInput = this.page.locator('#search, input[placeholder*="Filter by email" i]').first();
      await filterInput.waitFor({ state: 'visible', timeout: 10000 });
      await filterInput.fill('');
      await filterInput.fill(normalizedEmail);
      await this.page.waitForTimeout(500);

      // 2. Select the candidate row in the left users list
      const candidateItem = this.page.locator(`text="${normalizedEmail}"`).first();
      const count = await candidateItem.count();
      if (count === 0) {
        // Check partial match before '@'
        const prefix = normalizedEmail.split('@')[0];
        const partialItem = this.page.locator(`text="${prefix}"`).first();
        if ((await partialItem.count()) === 0) {
          throw new Error(`Candidate email '${normalizedEmail}' not found in Zoho users list.`);
        }
        await partialItem.click();
      } else {
        await candidateItem.click();
      }

      await this.page.waitForTimeout(600);

      // Wait for mailbox detail / readBlock to appear
      await this.page.waitForSelector('#readBlock:not(.hidden), button#readMailsBtn', { timeout: 10000 }).catch(() => {});

      // 3. Poll incoming messages by clicking "Read mails" every 5 seconds
      const pollInterval = config.ZOHO_CONNECTOR_POLL_INTERVAL_MS ?? 5000;
      console.log(
        `[Zoho Reader] ⏳ Polling messages for verification/security code every ${Math.round(pollInterval / 1000)}s (up to ${Math.round(
          timeoutMs / 1000
        )}s, cutoff: ${new Date(sinceTimestamp).toLocaleTimeString()})...`
      );
      const startTime = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        const cycleStart = Date.now();

        // Click "Read mails" to fetch incoming messages from Zoho Mail
        const readMailsBtn = this.page.locator('button#readMailsBtn, button:has-text("Read mails")').first();
        if ((await readMailsBtn.count()) > 0 && (await readMailsBtn.isVisible().catch(() => false))) {
          const isDisabled = await readMailsBtn.isDisabled().catch(() => false);
          if (!isDisabled) {
            console.log('[Zoho Reader] 🔄 Clicking "Read mails" to fetch latest emails...');
            await readMailsBtn.click().catch(() => {});
          }
        }

        // Wait briefly for list render
        await this.page.waitForTimeout(800);

        // Inspect ONLY the latest mails (top messages in the list, ordered latest → older)
        const messageItems = this.page.locator('#messageList button.msg-item, .message-col button.msg-item');
        const itemCount = await messageItems.count();

        if (itemCount > 0) {
          // Strictly inspect only the latest mails (at most top 3 messages)
          const checkLimit = Math.min(itemCount, 3);

          for (let i = 0; i < checkLimit; i++) {
            const item = messageItems.nth(i);
            const isVis = await item.isVisible().catch(() => false);
            if (!isVis) continue;

            const whenText = (await item.locator('.when').innerText().catch(() => '')).replace(/[·📎\s]+/g, ' ').trim();
            const subject = (await item.locator('.subject').innerText().catch(() => '')).trim();
            const from = (await item.locator('.from').innerText().catch(() => '')).trim();

            const parsedTime = whenText ? Date.parse(whenText) : NaN;

            // Since messages are ordered latest-first, if this message is older than the cutoff timestamp,
            // all subsequent messages are even older. Skip opening stale emails.
            if (!Number.isNaN(parsedTime) && parsedTime < sinceTimestamp) {
              if (i === 0) {
                console.log(
                  `[Zoho Reader] ⏳ Latest email is from ${whenText} (before submission). Waiting for new OTP mail...`
                );
              }
              break;
            }

            // Click message to inspect in right pane
            await item.click().catch(() => {});

            // Wait for message body container to finish loading
            await this.page
              .waitForSelector('#messageBody .body-html, #messageBody .body-text, #messageBody h3', { timeout: 4000 })
              .catch(() => {});
            await this.page.waitForTimeout(400);

            // Read content from message body
            const bodyText = await this.page.evaluate(() => {
              const bodyContainer =
                document.querySelector('#messageBody .body-html, #messageBody .body-text, #messageBody') ||
                document.querySelector('.email-body, .message-content');
              return bodyContainer ? (bodyContainer as HTMLElement).innerText || bodyContainer.textContent || '' : '';
            });

            const extractedOtp = this.extractOtpCode(bodyText);
            if (extractedOtp) {
              console.log(`[Zoho Reader] 🎯 Found OTP: ${extractedOtp} (subject: "${subject}", from: "${from}")`);
              return {
                success: true,
                otp: extractedOtp,
                subject,
                receivedAt: whenText,
              };
            }
          }
        }

        // Sleep remaining duration to enforce strict 5-second cadence between "Read mails" clicks
        const cycleElapsed = Date.now() - cycleStart;
        const sleepTime = Math.max(300, pollInterval - cycleElapsed);
        await this.page.waitForTimeout(sleepTime);
      }

      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for OTP email in Zoho Reader.`);
    } catch (err: any) {
      console.error(`[Zoho Reader] ❌ Failed to fetch OTP for ${candidateEmail}: ${err.message}`);
      return {
        success: false,
        errorMessage: err.message,
      };
    } finally {
      await this.idlePage();
      release();
    }
  }

  /**
   * Extracts an alphanumeric or numeric OTP code from email text body.
   */
  public extractOtpCode(text: string): string | null {
    if (!text) return null;

    // Pattern 1: Explicit labeled OTP code (numeric or alphanumeric, 6-16 chars)
    const explicitMatch = text.match(
      /(?:security\s*code|verification\s*code|verify\s*your\s*account\s*with|one-time\s*(?:passcode|code|password)|your\s*(?:verification\s*)?code|enter\s*(?:the\s*)?(?:following\s*)?code|confirmation\s*code|temporary\s*code)(?:\s+is|\s*:)?[\s\r\n:=]+([A-Za-z0-9]{6,16})/i
    );
    if (explicitMatch && explicitMatch[1]) {
      return explicitMatch[1].trim();
    }

    // Pattern 2: 8-character alphanumeric code standalone (Greenhouse standard verification e.g. Aebf0aDc)
    const words = text.match(/\b([A-Za-z0-9]{8})\b/g) || [];
    const stopWords = new Set([
      'security',
      'complete',
      'received',
      'position',
      'employer',
      'location',
      'continue',
      'question',
      'response',
      'required',
      'password',
      'username',
      'greenhou',
      'candidate',
      'settings',
    ]);
    for (const w of words) {
      if (!stopWords.has(w.toLowerCase())) {
        if (/[0-9]/.test(w) || (/[A-Z]/.test(w) && /[a-z]/.test(w))) {
          return w;
        }
      }
    }

    // Pattern 3: 6-digit numeric code
    const sixDigitMatch = text.match(/\b(\d{6})\b/);
    if (sixDigitMatch && sixDigitMatch[1]) {
      return sixDigitMatch[1].trim();
    }

    return null;
  }

  /**
   * Finds a confirmation email received after apply time with matching company name; returns JSON text (no screenshot).
   */
  public async captureConfirmationEmailContent(
    candidateEmail: string,
    criteria: {
      companyName?: string;
      jobTitle?: string;
      timeoutMs?: number;
      sinceTimestamp?: number;
      isManual?: boolean;
    } = {}
  ): Promise<{ success: boolean; email?: EmailProofJson; errorMessage?: string }> {
    const timeoutMs = criteria.timeoutMs ?? (criteria.isManual ? 45000 : 180000);
    const sinceTimestamp =
      criteria.sinceTimestamp !== undefined ? criteria.sinceTimestamp : Date.now() - 30 * 60 * 1000;
    const normalizedEmail = candidateEmail.trim().toLowerCase();
    const targetCompany = (criteria.companyName || '').trim();

    if (!targetCompany || targetCompany.length < 2) {
      return { success: false, errorMessage: 'Company name is required to match the correct confirmation email.' };
    }
    if (!normalizedEmail) {
      return { success: false, errorMessage: 'Candidate email is required for confirmation email capture.' };
    }

    const release = await this.acquireLock();
    try {
      await this.init();
      if (!this.page || this.page.isClosed()) {
        throw new Error('Zoho Reader page is unavailable.');
      }

      console.log(
        `[Zoho Reader] 📧 Looking up confirmation email for ${normalizedEmail} (company: "${targetCompany}", since: ${new Date(sinceTimestamp).toISOString()})...`
      );

      const filterInput = this.page.locator('input[placeholder*="Filter by email" i]').first();
      await filterInput.waitFor({ state: 'visible', timeout: 10000 });
      await filterInput.fill('');
      await filterInput.fill(normalizedEmail);
      await this.page.waitForTimeout(500);

      const candidateItem = this.page.locator(`text="${normalizedEmail}"`).first();
      if ((await candidateItem.count()) === 0) {
        const prefix = normalizedEmail.split('@')[0];
        const partialItem = this.page.locator(`text="${prefix}"`).first();
        if ((await partialItem.count()) === 0) {
          throw new Error(`Candidate email '${normalizedEmail}' not found in Zoho users list.`);
        }
        await partialItem.click();
      } else {
        await candidateItem.click();
      }

      await this.page.waitForTimeout(600);

      const readMailsBtn = this.page.locator('button:has-text("Read mails"), button:has-text("Refresh list")').first();
      if ((await readMailsBtn.count()) > 0 && (await readMailsBtn.isVisible())) {
        await readMailsBtn.click().catch(() => {});
        await this.page.waitForTimeout(1500);
      }

      const startTime = Date.now();
      const pollInterval = config.ZOHO_CONNECTOR_POLL_INTERVAL_MS || 2500;

      while (Date.now() - startTime < timeoutMs) {
        const refreshBtn = this.page.locator('button#readMailsBtn, button:has-text("Read mails")').first();
        if ((await refreshBtn.count()) > 0 && (await refreshBtn.isVisible().catch(() => false))) {
          const isDisabled = await refreshBtn.isDisabled().catch(() => false);
          if (!isDisabled) {
            await refreshBtn.click().catch(() => {});
          }
        }
        await this.page.waitForTimeout(1000);

        const allRows = this.page.locator('#messageList button.msg-item, .message-col button.msg-item');
        const rowCount = await allRows.count();
        const checkLimit = Math.min(rowCount, 10);

        for (let i = 0; i < checkLimit; i++) {
          const row = allRows.nth(i);
          if (!(await row.isVisible().catch(() => false))) continue;

          const whenLocator = row.locator('.when');
          const whenTitle = (await whenLocator.getAttribute('title').catch(() => '')) || '';
          const whenText = (await whenLocator.innerText().catch(() => '')).replace(/[·📎\s]+/g, ' ').trim();
          const subject = (await row.locator('.subject').innerText().catch(() => '')).trim();
          const from = (await row.locator('.from').innerText().catch(() => '')).trim();

          const parsedTime = parseZohoEmailTimestamp(whenText, whenTitle);
          if (parsedTime === null || parsedTime < sinceTimestamp) {
            if (i === 0 && parsedTime !== null) {
              console.log(
                `[Zoho Reader] ⏳ Latest email (${whenText}) is before apply window; waiting for new mail...`
              );
            }
            break;
          }

          await row.click().catch(() => {});
          await this.page
            .waitForSelector('#messageBody .body-html, #messageBody .body-text, #messageBody', { timeout: 4000 })
            .catch(() => {});
          await this.page.waitForTimeout(600);

          const bodyText = ((await this.page
            .locator('#messageBody .body-html, #messageBody .body-text, #messageBody')
            .first()
            .innerText()
            .catch(() => '')) || '').trim();

          if (!matchCompanyInEmail(targetCompany, from, subject, bodyText)) {
            continue;
          }
          if (!matchConfirmationContent(subject, bodyText)) {
            continue;
          }

          const receivedAt = new Date(parsedTime).toISOString();
          console.log(`[Zoho Reader] 📧 Matched confirmation email: "${subject}" @ ${receivedAt}`);

          return {
            success: true,
            email: {
              from: from || 'Unknown',
              subject: subject || 'Application confirmation',
              received_at: receivedAt,
              body_text: bodyText,
            },
          };
        }

        await this.page.waitForTimeout(pollInterval);
      }

      throw new Error(
        `Timed out waiting for confirmation email for "${targetCompany}" after apply time.`
      );
    } catch (err: any) {
      console.error(`[Zoho Reader] ❌ Confirmation email capture failed for ${candidateEmail}: ${err.message}`);
      return { success: false, errorMessage: err.message };
    } finally {
      await this.idlePage();
      release();
    }
  }

  /** @deprecated Screenshots removed — use captureConfirmationEmailContent. */
  public async captureConfirmationEmailScreenshot(
    candidateEmail: string,
    criteria: Parameters<ZohoReaderService['captureConfirmationEmailContent']>[1] = {}
  ): Promise<{ success: boolean; screenshotBuffer?: Buffer; subject?: string; errorMessage?: string }> {
    const result = await this.captureConfirmationEmailContent(candidateEmail, criteria);
    if (!result.success) {
      return { success: false, errorMessage: result.errorMessage };
    }
    return { success: true, subject: result.email?.subject };
  }

  /**
   * Closes browser session gracefully.
   */
  public async cleanup(): Promise<void> {
    try {
      if (this.page && !this.page.isClosed()) {
        await this.page.close().catch(() => {});
      }
      if (this.context) {
        await this.context.close().catch(() => {});
      }
      if (this.browser) {
        await this.browser.close().catch(() => {});
      }
    } catch {
      // Ignored
    } finally {
      this.page = null;
      this.context = null;
      this.browser = null;
    }
  }
}

export const zohoReader = new ZohoReaderService();
export default zohoReader;

