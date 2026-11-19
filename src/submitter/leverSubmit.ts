/**
 * @fileoverview Playwright Live Submission & Form Filling Engine for Lever ATS.
 *
 * Implements:
 * 1. Residential proxy routing with candidate geo-targeting (Massive primary, Apify fallback).
 * 2. Humanized typing cadence (pressSequentially with randomized jitter).
 * 3. Dedicated location autocomplete handler to prevent retrieveLocations.js blur clear bug.
 * 4. Custom card resolution (multiple-choice radios, checkboxes, text, textarea, select).
 * 5. Invisible hCaptcha telemetry evaluation & challenge modal detection.
 * 6. Dry-run safety with route interception to prevent unintended live employer submissions.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Page, BrowserContext } from 'playwright';
import { browserManager } from './browserManager.js';
import {
  buildAshbyProxyConfig,
  verifyProxyPreflight,
} from './ashbyProxy.js';
import { preflightFallback } from './ashbySubmit.js';
import { downloadResumeTempFile, isDemoResumeApplywizzId } from '../db/storage.js';
import { getProfile, type ProfileRow } from '../db/profiles.js';
import type { ApplicationRow, LeverSubmissionTelemetry, LeverSubmissionStage, VerificationFailureDetails } from '../db/applications/types.js';
import type { ResolvedField } from '../types/index.js';
import type { LiveSubmitResult } from './liveSubmit.js';
import { createLogger } from '../utils/logger.js';
import { toLeverApplicationUrl } from '../scanner/atsDetector.js';
import { matchChoiceOption } from '../utils/choiceOptions.js';
import { observeAtsVerification, type VerificationObservation, isVerificationResource } from './atsVerification.js';
import { humanType as sharedHumanType, pauseBetweenFields as sharedPauseBetweenFields } from './humanCadence.js';
import { updateStatus } from '../db/applications/crud.js';
import { uploadFailedScreenshot } from '../db/storage.js';
import { emitFailureDiagnostic } from '../utils/failureDiagnostics.js';

const log = createLogger('LeverSubmit');

export interface LeverSubmitOptions {
  application: ApplicationRow;
  profile: ProfileRow;
  headless?: boolean;
  dryRun?: boolean;
  interceptPost?: boolean;
  timeoutMs?: number;
  useProxy?: boolean;
  onTelemetry?: (telemetry: LeverSubmissionTelemetry) => void;
  preloadedResumePath?: string;
}

export interface LeverSubmitResult {
  success: boolean;
  stage: LeverSubmissionStage;
  error?: string;
  screenshotPath?: string;
  failureScreenshot?: Buffer;
  verificationFailure?: VerificationFailureDetails;
  submitClicked: boolean;
  submitClickedAt: string | null;
  hcaptchaDetected: boolean;
  hcaptchaSilentPass: boolean;
  challengeType: 'none' | 'hcaptcha' | 'cloudflare' | 'unknown';
  telemetry: LeverSubmissionTelemetry;
}

export type LeverSubmitOutcome = 'confirmed' | 'challenge' | 'unconfirmed';

export interface WaitForLeverSubmitOutcomeOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  baseline?: LeverSubmitOutcomeBaseline;
}

export interface LeverSubmitOutcomeBaseline {
  url: string;
  visibleReceiptTexts: string[];
}

const LEVER_RECEIPT_SELECTOR =
  '[data-qa="application-receipt"], #application-receipt, .application-receipt';

async function getVisibleLeverReceiptTexts(page: Page): Promise<string[]> {
  const receipts = page.locator(LEVER_RECEIPT_SELECTOR);
  const count = await receipts.count().catch(() => 0);
  const texts: string[] = [];
  for (let index = 0; index < count; index++) {
    const receipt = receipts.nth(index);
    if (await receipt.isVisible().catch(() => false)) {
      texts.push((await receipt.innerText().catch(() => '')).trim());
    }
  }
  return texts;
}

export async function captureLeverSubmitOutcomeBaseline(page: Page): Promise<LeverSubmitOutcomeBaseline> {
  return {
    url: page.url(),
    visibleReceiptTexts: await getVisibleLeverReceiptTexts(page),
  };
}

function hasNewReceipt(currentTexts: string[], baselineTexts: string[]): boolean {
  const remainingBaselineCounts = new Map<string, number>();
  for (const text of baselineTexts) {
    remainingBaselineCounts.set(text, (remainingBaselineCounts.get(text) ?? 0) + 1);
  }

  for (const text of currentTexts) {
    const remainingCount = remainingBaselineCounts.get(text) ?? 0;
    if (remainingCount === 0) return true;
    remainingBaselineCounts.set(text, remainingCount - 1);
  }
  return false;
}

/**
 * Waits for affirmative browser evidence that Lever accepted the application.
 * A verification token is only frontend widget state and is never confirmation.
 */
export async function waitForLeverSubmitOutcome(
  page: Page,
  options: WaitForLeverSubmitOutcomeOptions = {}
): Promise<LeverSubmitOutcome> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const baseline = options.baseline ?? await captureLeverSubmitOutcomeBaseline(page);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const url = page.url();
    let pathname = '';
    try {
      pathname = new URL(url).pathname;
    } catch {
      // An about:blank or malformed local URL is not confirmation.
    }

    if (
      page.url() !== baseline.url &&
      /(?:^|\/)thanks(?:\/|$)/i.test(pathname)
    ) return 'confirmed';

    const currentReceiptTexts = await getVisibleLeverReceiptTexts(page);
    if (hasNewReceipt(currentReceiptTexts, baseline.visibleReceiptTexts)) return 'confirmed';

    if ((await observeAtsVerification(page, 'lever')).kind === 'interactive') return 'challenge';

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await page.waitForTimeout(Math.min(pollIntervalMs, remainingMs));
  }

  return 'unconfirmed';
}

/**
 * Normalizes full candidate name, avoiding internal AWL- prefixes.
 */
function resolveCandidateFullName(profile: ProfileRow, resolvedFields: ResolvedField[]): string {
  const nameField = resolvedFields.find((f) => f.name === 'name' || f.fieldId === 'name');
  if (nameField?.value && typeof nameField.value === 'string' && !nameField.value.startsWith('AWL-')) {
    return nameField.value.trim();
  }
  if (profile.client_name && !profile.client_name.startsWith('AWL-')) {
    return profile.client_name.trim();
  }
  return `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || 'Candidate';
}

/**
 * Handles Lever location input autocomplete:
 * Types the city/state query, waits for .dropdown-location suggestions, and clicks the option
 * to ensure #selected-location is populated with the JSON object, preventing retrieveLocations.js blur clear.
 */
async function fillLeverLocation(page: Page, locationQuery: string): Promise<boolean> {
  const locInput = page.locator('input.location-input, #location-input, input[name="location"]').first();
  if ((await locInput.count()) === 0) return true;

  try {
    await locInput.scrollIntoViewIfNeeded().catch(() => {});
    await locInput.click({ timeout: 3000 });
    await locInput.pressSequentially(locationQuery, { delay: 60 });

    // Wait for dropdown suggestion container
    const suggestion = page.locator('.dropdown-location, .dropdown-results .dropdown-location').first();
    const appeared = await suggestion.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);

    if (appeared) {
      await suggestion.click({ force: true, timeout: 2000 }).catch(() => {});
    }

    // Verify #selected-location has a value; if not, inject a fallback payload
    const selectedLocVal = await page.evaluate(() => {
      const hidden = document.querySelector('#selected-location') as HTMLInputElement | null;
      return hidden ? hidden.value : '';
    });

    if (!selectedLocVal) {
      await page.evaluate((loc) => {
        const hidden = document.querySelector('#selected-location') as HTMLInputElement | null;
        if (hidden) {
          hidden.value = JSON.stringify({ name: loc, city: loc });
        }
      }, locationQuery);
    }

    return true;
  } catch (err: any) {
    log.warn(`[LeverSubmit] Location autocomplete encountered note: ${err?.message || err}`);
    return false;
  }
}

export interface FillLeverFormOptions {
  humanize?: boolean;
  typingDelayMinMs?: number;
  typingDelayMaxMs?: number;
  fieldGapMinMs?: number;
  fieldGapMaxMs?: number;
  preloadedResumePath?: string;
}

/**
 * Populates all fields on a Lever application form.
 */
export async function fillLeverForm(
  page: Page,
  application: ApplicationRow,
  profile: ProfileRow,
  options?: FillLeverFormOptions
): Promise<{ filledCount: number; errors: string[] }> {
  const resolved = application.resolved_fields || [];
  let filledCount = 0;
  const errors: string[] = [];

  const humanize = Boolean(options?.humanize);
  const minDelay = options?.typingDelayMinMs ?? 45;
  const maxDelay = options?.typingDelayMaxMs ?? 95;
  const gapMin = options?.fieldGapMinMs ?? 1000;
  const gapMax = options?.fieldGapMaxMs ?? 2000;

  const assertNoInteractiveVerification = async () => {
    const observation = await observeAtsVerification(page, 'lever');
    if (observation.kind === 'none' || observation.kind === 'passive_widget') return;
    throw verificationError(observation, 'FIELDS_FILLED');
  };
  await assertNoInteractiveVerification();

  const humanType = async (locator: any, text: string) => {
    await sharedHumanType(locator, text, {
      humanize,
      typingDelayMinMs: minDelay,
      typingDelayMaxMs: maxDelay,
    });
    await assertNoInteractiveVerification();
  };

  const pauseGap = async () => {
    await sharedPauseBetweenFields(page, {
      humanize,
      fieldGapMinMs: gapMin,
      fieldGapMaxMs: gapMax,
    });
    await assertNoInteractiveVerification();
  };

  // 1. Full name
  const fullName = resolveCandidateFullName(profile, resolved);
  const nameInput = page.locator('input[name="name"], [data-qa="name-input"]').first();
  if ((await nameInput.count()) > 0) {
    await humanType(nameInput, fullName);
    filledCount++;
    await pauseGap();
  }

  // 2. Email
  const emailVal = profile.company_email || profile.email || '';
  const emailInput = page.locator('input[name="email"], [data-qa="email-input"]').first();
  if ((await emailInput.count()) > 0 && emailVal) {
    await humanType(emailInput, emailVal);
    filledCount++;
    await pauseGap();
  }

  // 3. Phone
  const phoneVal = profile.phone || '';
  const phoneInput = page.locator('input[name="phone"], [data-qa="phone-input"]').first();
  if ((await phoneInput.count()) > 0 && phoneVal) {
    await humanType(phoneInput, phoneVal);
    filledCount++;
    await pauseGap();
  }

  // 4. Current company / org
  const companyVal = (profile as any).current_company || 'ApplyWizz';
  const orgInput = page.locator('input[name="org"], [data-qa="org-input"]').first();
  if ((await orgInput.count()) > 0) {
    await humanType(orgInput, companyVal);
    filledCount++;
    await pauseGap();
  }

  // 5. Social URLs
  const socialMappings: Record<string, string | undefined> = {
    'urls[LinkedIn]': profile.linkedin_url || undefined,
    'urls[GitHub]': profile.github_url || undefined,
    'urls[Portfolio]': profile.website_url || undefined,
    'urls[Twitter]': (profile as any).twitter_url || undefined,
  };

  for (const [inputName, urlVal] of Object.entries(socialMappings)) {
    if (!urlVal) continue;
    const input = page.locator(`input[name="${inputName}"]`).first();
    if ((await input.count()) > 0) {
      await humanType(input, urlVal);
      filledCount++;
      await pauseGap();
    }
  }

  // 6. Location Autocomplete
  const locVal = profile.location || 'San Jose, CA';
  await fillLeverLocation(page, locVal);
  await assertNoInteractiveVerification();
  filledCount++;
  await pauseGap();

  // 7. Resume upload
  const resumeInput = page.locator('input[type="file"]#resume-upload-input, input[name="resume"]').first();
  if ((await resumeInput.count()) > 0) {
    const resumePath = options?.preloadedResumePath;
    if (resumePath && fs.existsSync(resumePath)) {
      await resumeInput.setInputFiles(resumePath);
      filledCount++;
      await pauseGap();
    } else if (profile.resume_storage_path) {
      try {
        let localResumePath: string | null = null;
        if (isDemoResumeApplywizzId(profile.applywizz_id)) {
          localResumePath = path.resolve(process.cwd(), 'resumes', path.basename(profile.resume_storage_path));
        } else {
          localResumePath = await downloadResumeTempFile(profile.applywizz_id);
        }

        if (localResumePath && fs.existsSync(localResumePath)) {
          await resumeInput.setInputFiles(localResumePath);
          filledCount++;
          await pauseGap();
        }
      } catch (err: any) {
        log.warn(`[LeverSubmit] Resume upload note: ${err?.message || err}`);
      }
    }
  }

  // 8. Custom questions & cards
  for (const field of resolved) {
    const fieldName = field.name || '';
    if (!fieldName || !fieldName.startsWith('cards[')) continue;

    const val = String(field.value ?? '').trim();
    if (!val) continue;

    try {
      if (field.type === 'radio') {
        // Find matching radio input
        const radioExact = page.locator(`input[name="${fieldName}"][value="${val}"]`).first();
        if ((await radioExact.count()) > 0) {
          await radioExact.check({ force: true });
          filledCount++;
          await pauseGap();
          continue;
        }

        // Fuzzy match radio label
        const radios = page.locator(`input[name="${fieldName}"]`);
        const count = await radios.count();
        let matched = false;
        for (let i = 0; i < count; i++) {
          const r = radios.nth(i);
          const rVal = await r.getAttribute('value');
          if (rVal && matchChoiceOption(val, [rVal])) {
            await r.check({ force: true });
            filledCount++;
            await pauseGap();
            matched = true;
            break;
          }
        }
        if (!matched && count > 0) {
          await radios.first().check({ force: true });
          filledCount++;
          await pauseGap();
        }
      } else if (field.type === 'checkbox') {
        const cb = page.locator(`input[name="${fieldName}"][value="${val}"]`).first();
        if ((await cb.count()) > 0) {
          await cb.check({ force: true });
          filledCount++;
          await pauseGap();
        }
      } else if (field.type === 'select') {
        const select = page.locator(`select[name="${fieldName}"]`).first();
        if ((await select.count()) > 0) {
          await select.selectOption({ label: val }).catch(async () => {
            await select.selectOption({ value: val }).catch(() => {});
          });
          filledCount++;
          await pauseGap();
        }
      } else if (field.type === 'textarea') {
        const area = page.locator(`textarea[name="${fieldName}"]`).first();
        if ((await area.count()) > 0) {
          await humanType(area, val);
          filledCount++;
          await pauseGap();
        }
      } else {
        const txt = page.locator(`input[name="${fieldName}"]`).first();
        if ((await txt.count()) > 0) {
          await humanType(txt, val);
          filledCount++;
          await pauseGap();
        }
      }
    } catch (err: any) {
      errors.push(`Field ${fieldName} error: ${err?.message || err}`);
    }
  }

  // 9. Standard EEO Dropdowns
  const eeoMappings: Array<{ name: string; key: string }> = [
    { name: 'eeo[gender]', key: 'gender' },
    { name: 'eeo[race]', key: 'race' },
    { name: 'eeo[veteran]', key: 'veteran_status' },
  ];

  for (const eeo of eeoMappings) {
    const eeoSelect = page.locator(`select[name="${eeo.name}"]`).first();
    if ((await eeoSelect.count()) > 0) {
      const rawVal = String((profile as any)[eeo.key] || '').trim();
      if (rawVal) {
        await eeoSelect.selectOption({ label: rawVal }).catch(async () => {
          // Fallback to substring matching option
          const options = await eeoSelect.locator('option').allTextContents().catch(() => []);
          const match = matchChoiceOption(rawVal, options);
          if (match) {
            await eeoSelect.selectOption({ label: match }).catch(() => {});
          }
        });
        await pauseGap();
      }
    }
  }

  // 10. Cascading disability electronic signature
  const disabilitySignature = page.locator('#disabilitySignatureSection').first();
  if ((await disabilitySignature.count()) > 0 && (await disabilitySignature.isVisible().catch(() => false))) {
    const sigNameInput = disabilitySignature.locator('input[type="text"]').first();
    if ((await sigNameInput.count()) > 0) {
      await humanType(sigNameInput, fullName);
      filledCount++;
      await pauseGap();
    }
  }

  await assertNoInteractiveVerification();
  return { filledCount, errors };
}

function verificationError(observation: VerificationObservation, stage: string): Error & {
  stage: string;
  classification: string;
  provider?: string;
  reasonCode?: VerificationFailureDetails['reasonCode'];
} {
  const reasonCode = observation.kind === 'interactive' ? 'INTERACTIVE_CHALLENGE' : 'WIDGET_ERROR';
  const error = new Error(
    observation.kind === 'interactive'
      ? `Lever interactive verification detected during ${stage}: human verification challenge`
      : `Lever verification widget error during ${stage}`
  ) as Error & { stage: string; classification: string; provider?: string; reasonCode?: VerificationFailureDetails['reasonCode'] };
  error.stage = stage;
  error.classification = `EXTERNAL_POLICY:${reasonCode}`;
  error.provider = 'provider' in observation ? observation.provider : undefined;
  error.reasonCode = reasonCode;
  return error;
}

function verificationFailure(
  reasonCode: VerificationFailureDetails['reasonCode'],
  provider: VerificationFailureDetails['provider'],
  stage: string,
  submitClicked: boolean,
  submitClickedAt: string | null,
): VerificationFailureDetails {
  return {
    reasonCode,
    ats: 'lever',
    provider,
    stage,
    capturedAt: new Date().toISOString(),
    submitClicked,
    submitClickedAt,
  };
}

function providerFromTelemetry(challengeType: LeverSubmissionTelemetry['challengeType']): VerificationFailureDetails['provider'] {
  if (challengeType === 'hcaptcha') return 'hcaptcha';
  if (challengeType === 'cloudflare') return 'turnstile';
  return 'unknown';
}

/**
 * Executes Lever application submission using Playwright.
 */
export async function executeLeverSubmit(options: LeverSubmitOptions): Promise<LeverSubmitResult> {
  const { application, profile, dryRun = false, interceptPost = false, timeoutMs = 60000 } = options;
  const applicationUrl = toLeverApplicationUrl(application.job_url) || application.job_url;

  const telemetry: LeverSubmissionTelemetry = {
    stage: 'INITIALIZED',
    capturedAt: new Date().toISOString(),
    hcaptchaDetected: false,
    hcaptchaSilentPass: false,
    challengeType: 'none',
  };

  options.onTelemetry?.(telemetry);

  let managedBrowser = await browserManager.acquireBrowser({ headless: options.headless ?? true });
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let submitClicked = false;
  let submitClickedAt: string | null = null;
  let failureScreenshot: Buffer | undefined;

  try {
    // 1. Proxy resolution
    if (options.useProxy) {
      telemetry.stage = 'PROXY_PREFLIGHT';
      options.onTelemetry?.(telemetry);

      const proxyOpts = buildAshbyProxyConfig(profile);
      context = await browserManager.createSterileContext(managedBrowser.browser, {
        proxy: proxyOpts ? { server: proxyOpts.server, username: proxyOpts.username, password: proxyOpts.password } : undefined,
      });
      page = await context.newPage();

      const preflight = await verifyProxyPreflight(page);
      if (!preflight.success) {
        // Fallback to Apify
        const apifyFallback = await preflightFallback({
          page,
          preflight,
          shouldFallback: true,
          releaseCurrent: async () => { await context?.close().catch(() => {}); },
          acquireFallback: async () => {
            const apifyOpts = buildAshbyProxyConfig(profile, { provider: 'apify' });
            context = await browserManager.createSterileContext(managedBrowser.browser, {
              proxy: apifyOpts ? { server: apifyOpts.server, username: apifyOpts.username, password: apifyOpts.password } : undefined,
            });
            return await context.newPage();
          },
          verify: verifyProxyPreflight,
        });
        page = apifyFallback.page;
        telemetry.proxyOutcome = apifyFallback.preflight.success ? 'fallback_apify' : 'fallback_failed';
      } else {
        telemetry.proxyOutcome = 'primary_massive';
      }
    } else {
      context = await browserManager.createSterileContext(managedBrowser.browser);
      page = await context.newPage();
    }

    // Route abortion safeguard when testing on live employer postings
    if (interceptPost) {
      await page.route('**/postings/**/apply', (route) => {
        if (isVerificationResource(route.request().url())) {
          void route.continue();
          return;
        }
        log.info(`[LeverSubmit] 🛡️ Intercepted and blocked live POST request to ${route.request().url()}`);
        void route.abort('blockedbyclient');
      });
      await page.route('**/apply', (route) => {
        if (isVerificationResource(route.request().url())) {
          void route.continue();
          return;
        }
        if (route.request().method() === 'POST') {
          log.info(`[LeverSubmit] 🛡️ Intercepted and blocked live POST request to ${route.request().url()}`);
          void route.abort('blockedbyclient');
        } else {
          void route.continue();
        }
      });
    }

    // 2. Navigation
    telemetry.stage = 'NAVIGATED';
    options.onTelemetry?.(telemetry);
    await page.goto(applicationUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // 3. Form mounted check
    telemetry.stage = 'FORM_MOUNTED';
    options.onTelemetry?.(telemetry);
    await page.waitForSelector('form#application-form, #btn-submit', { timeout: 15000 });
    const mountVerification = await observeAtsVerification(page, 'lever');
    if (mountVerification.kind === 'interactive' || mountVerification.kind === 'widget_error') throw verificationError(mountVerification, 'FORM_MOUNTED');

    // 4. Fill form (humanized typing and 1-2s field gaps)
    telemetry.stage = 'FIELDS_FILLED';
    const fillResult = await fillLeverForm(page, application, profile, {
      humanize: true,
      fieldGapMinMs: 1000,
      fieldGapMaxMs: 2000,
      preloadedResumePath: options.preloadedResumePath,
    });
    telemetry.committedFieldCount = fillResult.filledCount;
    options.onTelemetry?.(telemetry);

    // Check for hCaptcha presence in DOM
    const hasHcaptcha = (await page.locator('.h-captcha, #h-captcha, iframe[src*="hcaptcha.com"]').count().catch(() => 0)) > 0;
    telemetry.hcaptchaDetected = hasHcaptcha;

    // 5. Dry-run cutoff
    if (dryRun) {
      telemetry.stage = 'COMPLETED';
      options.onTelemetry?.(telemetry);
      return {
        success: true,
        stage: 'COMPLETED',
        submitClicked,
        submitClickedAt,
        hcaptchaDetected: hasHcaptcha,
        hcaptchaSilentPass: false,
        challengeType: 'none',
        telemetry,
      };
    }

    // 5.5 Pre-submit hesitation delay (3.5s)
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })).catch(() => {});
    await page.waitForTimeout(3500);
    const preApplyVerification = await observeAtsVerification(page, 'lever');
    if (preApplyVerification.kind === 'interactive' || preApplyVerification.kind === 'widget_error') throw verificationError(preApplyVerification, 'PRE_SUBMIT');

    // 6. Submit click
    telemetry.stage = 'SUBMIT_CLICKED';
    const submitBtn = page.locator('#btn-submit, button[data-qa="btn-submit"]').first();
    await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
    const outcomeBaseline = await captureLeverSubmitOutcomeBaseline(page);
    // Record intent before invoking the one permitted Apply click. If click throws,
    // the catch result still records that submission may have reached the page.
    submitClicked = true;
    submitClickedAt = new Date().toISOString();
    telemetry.submitClickedAt = submitClickedAt;
    options.onTelemetry?.(telemetry);
    await submitBtn.click({ timeout: 5000 });

    // 7. Telemetry & bounded completion evaluation
    telemetry.stage = 'HCAPTCHA_EVALUATED';
    const outcome = await waitForLeverSubmitOutcome(page, { baseline: outcomeBaseline });

    if (outcome === 'confirmed') {
      telemetry.stage = 'CONFIRMED';
      telemetry.confirmedAt = new Date().toISOString();
    } else if (outcome === 'challenge') {
      telemetry.stage = 'CHALLENGE_DETECTED';
      const observation = await observeAtsVerification(page, 'lever');
      telemetry.challengeType = observation.kind === 'interactive'
        ? observation.provider === 'hcaptcha' ? 'hcaptcha' : observation.provider === 'turnstile' ? 'cloudflare' : 'unknown'
        : 'unknown';
      log.warn(`[LeverSubmit] ⚠️ Interactive hCaptcha challenge modal triggered for ${applicationUrl}`);
    }

    options.onTelemetry?.(telemetry);
    if (telemetry.stage !== 'CONFIRMED' && page) {
      failureScreenshot = await page.screenshot({ fullPage: true }).catch(() => undefined);
    }

    return {
      success: telemetry.stage === 'CONFIRMED' || (telemetry.stage as string) === 'COMPLETED',
      stage: telemetry.stage,
      error: telemetry.stage === 'CHALLENGE_DETECTED'
        ? 'Interactive verification stopped the Lever submission.'
        : telemetry.stage === 'HCAPTCHA_EVALUATED'
          ? 'Lever submission confirmation timed out.'
          : undefined,
      failureScreenshot,
      ...(telemetry.stage === 'CHALLENGE_DETECTED'
        ? { verificationFailure: verificationFailure('INTERACTIVE_CHALLENGE', providerFromTelemetry(telemetry.challengeType), telemetry.stage, submitClicked, submitClickedAt) }
        : telemetry.stage === 'HCAPTCHA_EVALUATED'
          ? { verificationFailure: verificationFailure('SUBMISSION_UNCONFIRMED', providerFromTelemetry(telemetry.challengeType), telemetry.stage, submitClicked, submitClickedAt) }
          : {}),
      submitClicked,
      submitClickedAt,
      hcaptchaDetected: hasHcaptcha,
      hcaptchaSilentPass: Boolean(telemetry.hcaptchaSilentPass),
      challengeType: telemetry.challengeType || 'none',
      telemetry,
    };
  } catch (err: any) {
    telemetry.stage = 'FAILED';
    telemetry.errorMessage = err?.message || String(err);
    const observation = page ? await observeAtsVerification(page, 'lever').catch(() => ({ kind: 'none' as const })) : { kind: 'none' as const };
    const failureDetails = err?.reasonCode
      ? verificationFailure(err.reasonCode, err.provider || 'unknown', err.stage || telemetry.stage, submitClicked, submitClickedAt)
      : observation.kind === 'interactive' || observation.kind === 'widget_error'
        ? verificationFailure(observation.kind === 'interactive' ? 'INTERACTIVE_CHALLENGE' : 'WIDGET_ERROR', observation.provider, err?.stage || telemetry.stage, submitClicked, submitClickedAt)
        : undefined;
    failureScreenshot = await page?.screenshot({ fullPage: true }).catch(() => undefined);
    options.onTelemetry?.(telemetry);
    return {
      success: false,
      stage: 'FAILED',
      error: telemetry.errorMessage,
      verificationFailure: failureDetails,
      failureScreenshot,
      submitClicked,
      submitClickedAt,
      hcaptchaDetected: Boolean(telemetry.hcaptchaDetected),
      hcaptchaSilentPass: false,
      challengeType: 'none',
      telemetry,
    };
  } finally {
    if (context) await context.close().catch(() => {});
    await browserManager.releaseBrowser(managedBrowser.browserId).catch(() => {});
  }
}

export async function submitLeverApplication(
  application: ApplicationRow,
  options: {
    headless?: boolean;
    preloadedResumePath?: string;
    updateStatusFn?: (id: string, status: any, extra?: any) => Promise<any>;
  } = {}
): Promise<LiveSubmitResult> {
  const applicationId = application.id || application.applywizz_id;
  const statusUpdater = options.updateStatusFn || updateStatus;
  let result: LeverSubmitResult;
  let localResumePath = options.preloadedResumePath;
  let shouldCleanupResume = false;

  try {
    const profile = await getProfile(application.applywizz_id);
    if (!profile) throw new Error('Profile not found for candidate.');

    if (!localResumePath && profile.resume_storage_path) {
      if (isDemoResumeApplywizzId(profile.applywizz_id)) {
        localResumePath = path.resolve(process.cwd(), 'resumes', path.basename(profile.resume_storage_path));
      } else {
        localResumePath = await downloadResumeTempFile(profile.applywizz_id);
        shouldCleanupResume = true;
      }
      if (!localResumePath || !fs.existsSync(localResumePath)) {
        throw new Error(`Failed to preload candidate resume for ${profile.applywizz_id}`);
      }
    }

    result = await executeLeverSubmit({
      application,
      profile,
      headless: options.headless,
      preloadedResumePath: localResumePath,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Lever submission failed.';
    result = {
      success: false,
      stage: 'FAILED',
      error: reason,
      submitClicked: false,
      submitClickedAt: null,
      hcaptchaDetected: false,
      hcaptchaSilentPass: false,
      challengeType: 'none',
      telemetry: { stage: 'FAILED', capturedAt: new Date().toISOString(), errorMessage: reason },
    };
  } finally {
    if (shouldCleanupResume && localResumePath && fs.existsSync(localResumePath)) {
      try { fs.unlinkSync(localResumePath); } catch {}
    }
  }

  const baseResult: LiveSubmitResult = {
    success: result.success,
    status: result.success ? 'APPLIED' : 'FAILED',
    applicationId,
    errorMessage: result.error,
    submitClicked: result.submitClicked,
    submitClickedAt: result.submitClickedAt,
    retryReason: null,
    verificationFailure: result.verificationFailure,
  };
  const proofFailedUrl = result.failureScreenshot
    ? await uploadFailedScreenshot(applicationId, result.failureScreenshot).catch((error) => {
      void emitFailureDiagnostic({
        category: 'SUBMIT_PROOF_CAPTURE', stage: 'failed_screenshot_upload', reason: 'Failed to store Lever failure screenshot.',
        error, applicationId: application.id, applywizzId: application.applywizz_id, jobUrl: application.job_url,
        isTerminal: false, isRetryable: true,
      });
      return undefined;
    })
    : undefined;
  const errorDetails = {
    deployedCommit: result.telemetry.deployedCommit,
    stage: result.telemetry.stage,
    exitIpHash: result.telemetry.exitIpHash,
    proxyRegion: result.telemetry.proxyRegion,
    proxyOutcome: result.telemetry.proxyOutcome,
    committedFieldCount: result.telemetry.committedFieldCount,
    hcaptchaDetected: result.telemetry.hcaptchaDetected,
    hcaptchaSilentPass: result.telemetry.hcaptchaSilentPass,
    challengeType: result.telemetry.challengeType,
    submitResponseStatus: result.telemetry.submitResponseStatus,
    capturedAt: result.telemetry.capturedAt,
    ...(baseResult.verificationFailure ? { verificationFailure: baseResult.verificationFailure } : {}),
    submitClicked: result.submitClicked,
    submitClickedAt: result.submitClickedAt,
    ...(result.telemetry.stage === 'HCAPTCHA_EVALUATED' ? { reasonCode: 'SUBMISSION_UNCONFIRMED' } : {}),
    ...(result.telemetry.stage === 'CHALLENGE_DETECTED' ? { reasonCode: 'INTERACTIVE_CHALLENGE' } : {}),
  };
  if (baseResult.verificationFailure) {
    const { reasonCode, stage } = baseResult.verificationFailure;
    const category = reasonCode === 'INTERACTIVE_CHALLENGE'
      ? 'SUBMIT_INTERACTIVE_CHALLENGE'
      : reasonCode === 'SUBMISSION_UNCONFIRMED'
        ? 'SUBMIT_CONFIRMATION_TIMEOUT'
        : reasonCode === 'WIDGET_ERROR'
          ? 'SUBMIT_FORM_FILL_ERROR'
          : 'SUBMIT_PLAYWRIGHT_NAVIGATE';
    await emitFailureDiagnostic({
      category,
      stage,
      reason: reasonCode === 'INTERACTIVE_CHALLENGE'
        ? 'Interactive verification stopped Lever submission.'
        : reasonCode === 'SUBMISSION_UNCONFIRMED'
          ? 'Lever submission was not confirmed after Apply.'
          : 'Lever verification failed before submission could be confirmed.',
      applicationId: application.id,
      applywizzId: application.applywizz_id,
      jobUrl: application.job_url,
      metadata: { reasonCode, retryable: false, terminal: true },
      isTerminal: true,
      isRetryable: false,
    });
  }
  let terminalResult = { ...baseResult, proofFailedUrl };
  try {
    const persisted = await statusUpdater(applicationId, result.success ? 'APPLIED' : 'FAILED', {
      ...(result.success ? {} : { error_message: result.error || 'Lever submission failed.' }),
      ...(proofFailedUrl ? { proof_failed_url: proofFailedUrl, proof_failed_captured_at: new Date().toISOString() } : {}),
      error_details: errorDetails,
      job_url: application.job_url,
    });
    if (persisted === false) throw new Error('Status updater did not persist the terminal transition.');
  } catch (error) {
    void emitFailureDiagnostic({
      category: 'SUBMIT_STATUS_PERSIST', stage: 'lever_terminal_status',
      reason: 'Could not persist Lever terminal submission status.', error,
      applicationId: application.id, applywizzId: application.applywizz_id, jobUrl: application.job_url,
      metadata: { reasonCode: baseResult.verificationFailure?.reasonCode || (result.success ? 'SUCCESS_STATUS_PERSIST_FAILED' : 'FAILURE_STATUS_PERSIST_FAILED') },
      isTerminal: false, isRetryable: true,
    });
    terminalResult = {
      ...terminalResult,
      success: false,
      status: 'FAILED',
      errorMessage: result.error || 'Lever submission status could not be persisted.',
    };
  }
  return terminalResult;
}
