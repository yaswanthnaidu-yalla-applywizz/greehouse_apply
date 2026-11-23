/**
 * @fileoverview Auto-dismissal of blocking page overlays, age-verification gates, and cookie consent modals.
 */

import type { Page } from 'playwright';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('OverlayDismissal');

/**
 * Common selectors and text targets for blocking overlays.
 */
export const OVERLAY_BUTTON_SELECTORS = [
  // Age verification gates (e.g. Manhattan Beer)
  'button:has-text("I\'m Over 21")',
  'button:has-text("I am 21 or older")',
  'button:has-text("I am 21+")',
  'button:has-text("Yes, I am 21")',
  'button:has-text("Yes, I\'m 21")',
  'button:has-text("Enter Site")',
  'button:has-text("I Agree, I am 21")',
  'a:has-text("I\'m Over 21")',
  '[role="button"]:has-text("I\'m Over 21")',

  // Cookie consent & privacy banners
  'button#onetrust-accept-btn-handler',
  '#onetrust-reject-all-handler',
  'button:has-text("Accept All Cookies")',
  'button:has-text("Accept all")',
  'button:has-text("Accept All")',
  'button:has-text("Allow all")',
  'button:has-text("Allow All")',
  'button:has-text("I Accept")',
  'button:has-text("Agree & Continue")',
  'button:has-text("Accept and close")',
  'button:has-text("Got it")',
  'button:has-text("Dismiss")',
  '[aria-label="Accept cookies"]',
  '[aria-label="Accept all cookies"]',
  '.cookie-banner button:has-text("Accept")',
  '#cookie-consent button:has-text("Accept")',
];

/**
 * Inspects the page for active blocking modals, age gates, or cookie banners and dismisses them.
 * Safe and non-blocking: returns true if any overlay was dismissed, false otherwise.
 */
export async function dismissBlockingOverlays(page: Page): Promise<boolean> {
  let anyDismissed = false;

  for (const selector of OVERLAY_BUTTON_SELECTORS) {
    try {
      const btn = page.locator(selector).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        log.info(`[OverlayDismissal] Found blocking overlay with selector "${selector}". Dismissing...`);
        await btn.click({ timeout: 2000, force: true }).catch(async () => {
          await btn.dispatchEvent('click').catch(() => {});
        });
        anyDismissed = true;
        // Brief pause for DOM transition
        await page.waitForTimeout(300).catch(() => {});
      }
    } catch {
      // Non-blocking: continue inspecting remaining candidates
    }
  }

  return anyDismissed;
}
