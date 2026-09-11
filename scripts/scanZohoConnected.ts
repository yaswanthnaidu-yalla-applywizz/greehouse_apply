/**
 * @fileoverview Playwright headless script for Zoho Mail Reader connected users scanner.
 *
 * Scrapes https://zoho-mail-reader.onrender.com/ and extracts emails of
 * users whose mailbox status is "Connected".
 *
 * Usage:
 *   npx tsx scripts/scanZohoConnected.ts
 *
 * Environment variables:
 *   ZOHO_READER_EMAIL     - Connector login username/email (fallback: ZOHO_CONNECTOR_USER)
 *   ZOHO_READER_PASSWORD  - Connector login password (fallback: ZOHO_CONNECTOR_PASS)
 *   ZOHO_CONNECTOR_URL    - Connector URL (default: https://zoho-mail-reader.onrender.com/)
 */

import { chromium, type Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

export interface ZohoConnectedScanResult {
  scannedAt: string;
  count: number;
  emails: string[];
}

const BASE_URL = process.env.ZOHO_CONNECTOR_URL || 'https://zoho-mail-reader.onrender.com/';
const EMAIL = process.env.ZOHO_READER_EMAIL || process.env.ZOHO_CONNECTOR_USER;
const PASSWORD = process.env.ZOHO_READER_PASSWORD || process.env.ZOHO_CONNECTOR_PASS;

export async function runZohoConnectedScan(): Promise<ZohoConnectedScanResult> {
  const scannedAt = new Date().toISOString();
  const outDir = path.resolve(process.cwd(), 'cache');
  const outPath = path.join(outDir, 'zoho_connected_emails.json');

  if (!EMAIL || !PASSWORD) {
    console.warn(
      '[Zoho Scanner] ⚠️ Missing ZOHO_READER_EMAIL / ZOHO_READER_PASSWORD (or ZOHO_CONNECTOR_USER / ZOHO_CONNECTOR_PASS) in environment.'
    );
    const fallbackResult: ZohoConnectedScanResult = {
      scannedAt,
      count: 0,
      emails: [],
    };
    try {
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }
      if (!fs.existsSync(outPath)) {
        fs.writeFileSync(outPath, JSON.stringify(fallbackResult, null, 2), 'utf-8');
      }
    } catch (writeErr: any) {
      console.warn(`[Zoho Scanner] ⚠️ Could not write fallback cache file: ${writeErr.message}`);
    }
    return fallbackResult;
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    console.log(`[Zoho Scanner] 🌐 Navigating to ${BASE_URL}...`);
    await page.goto(BASE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    // ── Step 1: Sign in if login form is visible ──────────────────────────────
    await performLoginIfNeeded(page, EMAIL, PASSWORD);

    // ── Step 2: Ensure Users list is loaded ──────────────────────────────────
    console.log('[Zoho Scanner] ⏳ Waiting for Users list to render...');
    await page.waitForSelector('text=Users, input[placeholder*="Filter by email" i], #search', {
      timeout: 20000,
    }).catch(() => {
      console.log('[Zoho Scanner] ℹ️ Users list selector timed out, attempting scrape on current DOM state.');
    });

    // ── Step 3: Look for "Connected" filter tab/button and click if present ──
    const connectedFilterSelectors = [
      'button:has-text("Connected")',
      'a:has-text("Connected")',
      '[role="tab"]:has-text("Connected")',
      'label:has-text("Connected")',
      'span:has-text("Connected")',
      'input[type="radio"][value*="connected" i]',
      'input[type="checkbox"][value*="connected" i]',
    ];

    let filterClicked = false;
    for (const sel of connectedFilterSelectors) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) > 0 && (await el.isVisible())) {
          await el.click();
          await page.waitForTimeout(1200);
          filterClicked = true;
          console.log(`[Zoho Scanner] 🔵 Clicked "Connected" filter: ${sel}`);
          break;
        }
      } catch {}
    }

    if (!filterClicked) {
      console.log(
        '[Zoho Scanner] ℹ️ "Connected" filter button not found or already selected — reading status badges from list.'
      );
    }

    // ── Step 4: Iterate all pages, collecting emails with Connected status ──
    const collectedEmails: string[] = [];
    let pageNum = 1;
    const maxPages = 50;

    while (pageNum <= maxPages) {
      console.log(`[Zoho Scanner] 📄 Scraping page ${pageNum}...`);
      await page.waitForTimeout(600);

      const emailsOnPage: string[] = await page.evaluate((isFiltered) => {
        const results: string[] = [];
        const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

        // Container-level extraction: checks row/item text for email AND "Connected" status
        const containers = document.querySelectorAll(
          'li, tr, [role="row"], .user-row, .user-item, .list-item, .candidate-row, button.user-item, div.user'
        );

        containers.forEach((el) => {
          const text = el.textContent || '';
          const matches = text.match(emailRegex);
          if (!matches) return;

          // If the "Connected" filter was clicked, all visible items are connected
          // Otherwise, verify the item text or badge contains "connected"
          const isConnected = isFiltered || /connected/i.test(text);
          if (isConnected) {
            matches.forEach((m) => results.push(m.toLowerCase().trim()));
          }
        });

        // Fallback: If containers didn't yield emails, search full DOM
        if (results.length === 0) {
          // If filtered, any email on page is connected
          if (isFiltered) {
            const bodyText = document.body.innerText || '';
            const allMatches = bodyText.match(emailRegex) || [];
            allMatches.forEach((m) => results.push(m.toLowerCase().trim()));
          } else {
            // Scan elements containing "connected"
            const connectedElements = Array.from(document.querySelectorAll('*')).filter((el) => {
              const children = el.children;
              return children.length === 0 && /connected/i.test(el.textContent || '');
            });

            connectedElements.forEach((badge) => {
              const parentRow = badge.closest('tr, li, [role="row"], div, button');
              if (parentRow) {
                const rowText = parentRow.textContent || '';
                const rowEmails = rowText.match(emailRegex);
                if (rowEmails) {
                  rowEmails.forEach((m) => results.push(m.toLowerCase().trim()));
                }
              }
            });
          }
        }

        return [...new Set(results)];
      }, filterClicked);

      collectedEmails.push(...emailsOnPage);
      console.log(`[Zoho Scanner]   → Page ${pageNum}: found ${emailsOnPage.length} email(s)`);

      // ── Pagination: Try to advance to the next page ────────────────────────
      const nextSelectors = [
        'button:has-text("Next")',
        'a:has-text("Next")',
        '[aria-label="Next page"]',
        'button[aria-label*="next" i]',
        '.pagination-next',
        'button:has-text("›")',
        'button:has-text(">")',
      ];

      let advanced = false;
      for (const sel of nextSelectors) {
        try {
          const btn = page.locator(sel).first();
          if ((await btn.count()) > 0 && (await btn.isVisible()) && (await btn.isEnabled())) {
            await btn.click();
            pageNum++;
            advanced = true;
            await page.waitForTimeout(800);
            break;
          }
        } catch {}
      }

      if (!advanced) {
        break; // No more pages
      }
    }

    // ── Step 5: Deduplicate and format output ────────────────────────────────
    const deduplicated = Array.from(
      new Set(
        collectedEmails
          .map((e) => e.toLowerCase().trim())
          .filter((e) => e.includes('@') && !e.includes('zoho') && !e.includes('noreply'))
      )
    ).sort();

    const result: ZohoConnectedScanResult = {
      scannedAt,
      count: deduplicated.length,
      emails: deduplicated,
    };

    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8');

    console.log(`[Zoho Scanner] ✅ Saved ${result.count} connected email(s) to ${outPath}`);
    return result;
  } catch (err: any) {
    console.error(`[Zoho Scanner] ❌ Error during scan: ${err.message}`);

    // Graceful error handling: ensure output file exists so downstream consumers don't crash
    const fallbackResult: ZohoConnectedScanResult = {
      scannedAt,
      count: 0,
      emails: [],
    };
    try {
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }
      if (!fs.existsSync(outPath)) {
        fs.writeFileSync(outPath, JSON.stringify(fallbackResult, null, 2), 'utf-8');
      }
    } catch {}

    return fallbackResult;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function performLoginIfNeeded(page: Page, user: string, pass: string): Promise<void> {
  const emailSelectors = [
    'input[placeholder*="Username" i]',
    'input[name*="user" i]',
    'input[type="email"]',
    'input[name="email"]',
    'input[placeholder*="email" i]',
    'input[type="text"]',
  ];
  const passSelectors = [
    'input[placeholder*="Password" i]',
    'input[name*="pass" i]',
    'input[type="password"]',
  ];
  const submitSelectors = [
    'button:has-text("Continue")',
    'button[type="submit"]',
    'button:has-text("Sign in")',
    'button:has-text("Login")',
    'input[type="submit"]',
  ];

  let usernameInput = null;
  for (const sel of emailSelectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
      usernameInput = loc;
      break;
    }
  }

  if (usernameInput) {
    console.log('[Zoho Scanner] 🔑 Sign-in form detected. Authenticating...');
    await usernameInput.fill(user);

    for (const sel of passSelectors) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        await loc.fill(pass);
        break;
      }
    }

    for (const sel of submitSelectors) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        await loc.click();
        break;
      }
    }

    await page.waitForSelector('text=Mailbox connector, text=Users, input[placeholder*="Filter by email" i]', {
      timeout: 25000,
    }).catch(() => {
      console.log('[Zoho Scanner] ℹ️ Dashboard selector wait completed.');
    });
  } else {
    console.log('[Zoho Scanner] ℹ️ Already authenticated or on dashboard.');
  }
}

// Direct execution entrypoint
if (process.argv[1] && process.argv[1].includes('scanZohoConnected')) {
  runZohoConnectedScan()
    .then((res) => {
      console.log(`[Zoho Scanner] Finished scan with ${res.count} connected user(s).`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Zoho Scanner] ❌ Fatal error:', err.message);
      process.exit(0); // Exit 0 to avoid crashing calling process or pipelines
    });
}
