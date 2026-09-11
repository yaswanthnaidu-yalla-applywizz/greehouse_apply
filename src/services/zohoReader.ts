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

export interface ZohoOtpResult {
  success: boolean;
  otp?: string;
  subject?: string;
  receivedAt?: string;
  errorMessage?: string;
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
   * Searches for an application confirmation email (e.g. "Thank you for applying", "Application received")
   * for the given candidate and captures a screenshot proof of the rendered email view.
   *
   * @param candidateEmail - Candidate's company email (e.g. user@applywizard.ai)
   * @param criteria - Optional company name or job title to match specific application
   */
  public async captureConfirmationEmailScreenshot(
    candidateEmail: string,
    criteria: { companyName?: string; jobTitle?: string; timeoutMs?: number; sinceTimestamp?: number; isManual?: boolean } = {}
  ): Promise<{
    success: boolean;
    screenshotBuffer?: Buffer;
    subject?: string;
    errorMessage?: string;
  }> {
    const timeoutMs = criteria.timeoutMs ?? (criteria.isManual ? 45000 : 180000);
    const sinceTimestamp = criteria.sinceTimestamp !== undefined
      ? criteria.sinceTimestamp
      : (criteria.isManual ? 0 : (Date.now() - 3 * 60 * 1000));
    const normalizedEmail = candidateEmail.trim().toLowerCase();

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
        `[Zoho Reader] 📧 Looking up confirmation email for ${normalizedEmail}${
          criteria.companyName ? ` (company: ${criteria.companyName})` : ''
        } (manual: ${Boolean(criteria.isManual)})...`
      );

      // 1. Filter by candidate email
      const filterInput = this.page.locator('input[placeholder*="Filter by email" i]').first();
      await filterInput.waitFor({ state: 'visible', timeout: 10000 });
      await filterInput.fill('');
      await filterInput.fill(normalizedEmail);
      await this.page.waitForTimeout(500);

      // 2. Select the candidate row in the left users list
      const candidateItem = this.page.locator(`text="${normalizedEmail}"`).first();
      const count = await candidateItem.count();
      if (count === 0) {
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

      // 3. Click "Read mails" or "Refresh list"
      const readMailsBtn = this.page.locator('button:has-text("Read mails"), button:has-text("Refresh list")').first();
      if ((await readMailsBtn.count()) > 0 && (await readMailsBtn.isVisible())) {
        await readMailsBtn.click().catch(() => {});
        await this.page.waitForTimeout(1500);
      }

      // 4. Poll incoming emails for confirmation messages
      const startTime = Date.now();
      const pollInterval = config.ZOHO_CONNECTOR_POLL_INTERVAL_MS || 2500;
      const targetCompany = (criteria.companyName || '').trim().toLowerCase();

      while (Date.now() - startTime < timeoutMs) {
        const refreshBtn = this.page.locator('button#readMailsBtn, button:has-text("Read mails")').first();
        if ((await refreshBtn.count()) > 0 && (await refreshBtn.isVisible().catch(() => false))) {
          const isDisabled = await refreshBtn.isDisabled().catch(() => false);
          if (!isDisabled) {
            await refreshBtn.click().catch(() => {});
          }
        }
        await this.page.waitForTimeout(1000);

        // Inspect recent messages in the candidate's folder
        const allRows = this.page.locator('#messageList button.msg-item, .message-col button.msg-item');
        const rowCount = await allRows.count();
        const checkLimit = Math.min(rowCount, 10);

        for (let i = 0; i < checkLimit; i++) {
          const row = allRows.nth(i);
          const isVis = await row.isVisible().catch(() => false);
          if (!isVis) continue;

          const whenText = (await row.locator('.when').innerText().catch(() => '')).replace(/[·📎\s]+/g, ' ').trim();
          const subject = (await row.locator('.subject').innerText().catch(() => '')).trim();
          const from = (await row.locator('.from').innerText().catch(() => '')).trim();

          const parsedTime = whenText ? Date.parse(whenText) : NaN;
          if (sinceTimestamp > 0 && !Number.isNaN(parsedTime) && parsedTime < sinceTimestamp && !criteria.isManual) {
            continue;
          }

          const combinedHeader = `${subject} ${from}`.toLowerCase();
          const isHeaderMatch =
            (targetCompany && targetCompany.length > 2 && combinedHeader.includes(targetCompany)) ||
            combinedHeader.includes('thank you') ||
            combinedHeader.includes('application') ||
            combinedHeader.includes('applied') ||
            combinedHeader.includes('received') ||
            combinedHeader.includes('greenhouse') ||
            combinedHeader.includes('confirm') ||
            combinedHeader.includes('candidate') ||
            criteria.isManual;

          if (isHeaderMatch) {
            await row.click().catch(() => {});
            await this.page
              .waitForSelector('#messageBody .body-html, #messageBody .body-text, #messageBody', { timeout: 4000 })
              .catch(() => {});
            await this.page.waitForTimeout(600);

            const emailContainer = this.page
              .locator('#messageBody .body-html, #messageBody .body-text, #messageBody')
              .first();
            const containerExists = (await emailContainer.count()) > 0;
            const targetLocator = containerExists ? emailContainer : this.page.locator('body');

            const text = ((await targetLocator.innerText().catch(() => '')) || '').toLowerCase();
            const isConfirmation =
              text.includes('thank you for applying') ||
              text.includes('thank you for your application') ||
              text.includes('we received your application') ||
              text.includes('application received') ||
              text.includes('applied') ||
              text.includes('greenhouse') ||
              text.includes('application') ||
              (targetCompany && targetCompany.length > 2 && text.includes(targetCompany));

            if (isConfirmation || criteria.isManual) {
              console.log(
                `[Zoho Reader] 📸 Confirmation email found! Capturing screenshot proof (subject: "${subject}")...`
              );
              await this.page.waitForTimeout(1000);

              const screenshotBuffer = await targetLocator.screenshot({
                type: 'png',
              });

              return {
                success: true,
                screenshotBuffer,
                subject: subject || targetCompany || 'Confirmation Email',
              };
            }
          }
        }

        await this.page.waitForTimeout(pollInterval);
      }

      throw new Error(
        `Timed out waiting for application confirmation email in Zoho Reader.`
      );
    } catch (err: any) {
      console.error(`[Zoho Reader] ❌ Confirmation email capture failed for ${candidateEmail}: ${err.message}`);
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
