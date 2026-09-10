/**
 * @fileoverview Web Proof Screenshot Capture & Storage Upload (Phase V2-4 / V2-5).
 *
 * Captures full-page confirmation screenshots upon verified submission completion,
 * uploads the buffer to the `proofs_web` Supabase Storage bucket, and records the
 * persistent proof URL and timestamp in `candidate_applications`.
 */

import type { Page } from 'playwright';
import {
  uploadProof,
  uploadFailedScreenshot,
  uploadJobOpenScreenshot,
  uploadJobSubmittedScreenshot,
  uploadEmailProof,
} from '../db/storage.js';
import {
  attachProofToApplication,
  attachEmailProofToApplication,
  updateEmailProofStatus,
  getApplication,
  type ApplicationRow,
} from '../db/applications.js';
import { getProfile, getCompanyEmail } from '../db/profiles.js';
import { zohoReader } from '../services/zohoReader.js';

export interface ProofCaptureResult {
  proofWebUrl: string;
  proofCapturedAt: string;
  url: string;
  capturedAt: string;
  proofUrl: string;
  timestamp: string;
}

function resolveStorageKey(application: ApplicationRow | string): string {
  if (typeof application === 'string') {
    return application;
  }
  return application.id || application.applywizz_id;
}

function resolveApplicationRef(
  application: ApplicationRow | string,
  jobUrl?: string
): Partial<Pick<ApplicationRow, 'id' | 'applywizz_id' | 'job_url'>> {
  if (typeof application === 'string') {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      application
    );
    return isUuid
      ? { id: application, job_url: jobUrl }
      : { applywizz_id: application, job_url: jobUrl };
  }
  return application;
}

/**
 * Captures a full-page screenshot of the confirmed Greenhouse application,
 * uploads it to Supabase Storage, and updates the application database record.
 *
 * @param page - Active Playwright page on the verified confirmation view
 * @param application - Application record (preferred) or legacy UUID / applywizz_id string
 * @param jobUrl - Required when passing applywizz_id string without full record
 */
export async function captureWebProof(
  page: Page,
  application: ApplicationRow | string,
  jobUrl?: string
): Promise<ProofCaptureResult> {
  const capturedAt = new Date().toISOString();
  const storageKey = resolveStorageKey(application);

  // Allow DOM to settle before capture (matches dry-run behaviour)
  await page.waitForTimeout(1000);

  const screenshotBuffer = await page.screenshot({
    fullPage: true,
    type: 'png',
  });

  const proofWebUrl = await uploadProof(storageKey, screenshotBuffer);
  const appRef = resolveApplicationRef(application, jobUrl);

  try {
    await attachProofToApplication(appRef, proofWebUrl, capturedAt);
    console.log(
      `[Proof Capture] 📸 Proof screenshot saved for application ${storageKey}: ${proofWebUrl}`
    );
  } catch (err: any) {
    console.warn(`[Proof Capture] ⚠️ Could not update DB record with proof URL: ${err.message}`);
  }

  return {
    proofWebUrl,
    proofCapturedAt: capturedAt,
    url: proofWebUrl,
    capturedAt,
    proofUrl: proofWebUrl,
    timestamp: capturedAt,
  };
}

/**
 * Captures a full-page screenshot of a failed Greenhouse application attempt
 * and uploads it to the `proofs_failed` Supabase Storage bucket or local folder.
 *
 * @param page - Active Playwright page
 * @param application - Application record or ID string
 */
export async function captureFailedScreenshot(
  page: Page,
  application: ApplicationRow | string
): Promise<{ proofFailedUrl: string; capturedAt: string; url: string; proofUrl: string }> {
  const capturedAt = new Date().toISOString();
  const storageKey = resolveStorageKey(application);

  if (page.isClosed()) {
    return {
      proofFailedUrl: '',
      capturedAt,
      url: '',
      proofUrl: '',
    };
  }

  await page.waitForTimeout(500).catch(() => {});

  const screenshotBuffer = await page
    .screenshot({
      fullPage: true,
      type: 'png',
    })
    .catch(() => null);

  if (!screenshotBuffer) {
    return {
      proofFailedUrl: '',
      capturedAt,
      url: '',
      proofUrl: '',
    };
  }

  const proofFailedUrl = await uploadFailedScreenshot(storageKey, screenshotBuffer);
  console.log(
    `[Proof Capture] 📸 Failure screenshot saved for application ${storageKey}: ${proofFailedUrl}`
  );

  return {
    proofFailedUrl,
    capturedAt,
    url: proofFailedUrl,
    proofUrl: proofFailedUrl,
  };
}

/**
 * Captures a full-page screenshot of the opened job form before filling,
 * and uploads it to the `proofs_job_open` bucket ({applicationId}_open.png).
 */
export async function captureJobOpenScreenshot(
  page: Page,
  application: ApplicationRow | string
): Promise<{ url: string; capturedAt: string }> {
  const capturedAt = new Date().toISOString();
  const storageKey = resolveStorageKey(application);

  if (page.isClosed()) {
    return { url: '', capturedAt };
  }

  await page.waitForTimeout(500).catch(() => {});

  const screenshotBuffer = await page
    .screenshot({
      fullPage: true,
      type: 'png',
    })
    .catch(() => null);

  if (!screenshotBuffer) {
    return { url: '', capturedAt };
  }

  const jobOpenUrl = await uploadJobOpenScreenshot(storageKey, screenshotBuffer);
  console.log(
    `[Proof Capture] 📸 Job open screenshot saved for application ${storageKey}: ${jobOpenUrl}`
  );

  return { url: jobOpenUrl, capturedAt };
}

/**
 * Captures a full-page screenshot immediately after clicking the submit button,
 * and uploads it to the `proofs_job_submitted` bucket ({applicationId}_submitted.png).
 */
export async function captureJobSubmittedScreenshot(
  page: Page,
  application: ApplicationRow | string
): Promise<{ url: string; capturedAt: string }> {
  const capturedAt = new Date().toISOString();
  const storageKey = resolveStorageKey(application);

  if (page.isClosed()) {
    return { url: '', capturedAt };
  }

  const screenshotBuffer = await page
    .screenshot({
      fullPage: true,
      type: 'png',
    })
    .catch(() => null);

  if (!screenshotBuffer) {
    return { url: '', capturedAt };
  }

  const jobSubmittedUrl = await uploadJobSubmittedScreenshot(storageKey, screenshotBuffer);
  console.log(
    `[Proof Capture] 📸 Job submitted screenshot saved for application ${storageKey}: ${jobSubmittedUrl}`
  );

  return { url: jobSubmittedUrl, capturedAt };
}

/**
 * Captures a confirmation email proof screenshot from the Zoho Mail Reader,
 * uploads it to the `proofs_mail` Supabase Storage bucket, and attaches the URL to the application record.
 * Designed to be run asynchronously in the background.
 */
export async function captureAndSaveEmailProof(
  application: ApplicationRow | string,
  options: { timeoutMs?: number } = {}
): Promise<string | null> {
  const storageKey = resolveStorageKey(application);
  let appRow: ApplicationRow | null = null;

  if (typeof application === 'string') {
    appRow = await getApplication(application);
  } else {
    appRow = application;
  }

  if (!appRow) {
    console.warn(`[Email Proof] ⚠️ Application record not found for ${storageKey}`);
    return null;
  }

  const appRef = resolveApplicationRef(appRow);

  // Set email proof status to pending
  try {
    await updateEmailProofStatus(appRef, 'pending');
  } catch (err: any) {
    console.warn(`[Email Proof] ⚠️ Could not set email_proof_status to pending: ${err.message}`);
  }

  // Resolve candidate's company email
  let companyEmail: string | null = null;
  try {
    const profile = await getProfile(appRow.applywizz_id);
    if (profile) {
      companyEmail = getCompanyEmail(profile);
    }
  } catch (err: any) {
    console.warn(`[Email Proof] ⚠️ Could not fetch profile for company email: ${err.message}`);
  }

  if (!companyEmail) {
    console.warn(`[Email Proof] ⚠️ No company email found for candidate ${appRow.applywizz_id}`);
    await updateEmailProofStatus(appRef, 'timed_out').catch(() => {});
    return null;
  }

  console.log(
    `[Email Proof] ⏳ Initiating background confirmation email capture for ${appRow.applywizz_id} (${companyEmail})...`
  );

  try {
    // Give external email service a 6-10 second delivery head start
    await new Promise((resolve) => setTimeout(resolve, 8000));

    const sinceTimestamp = appRow.submitted_at
      ? new Date(appRow.submitted_at).getTime() - 60000
      : (appRow.proof_captured_at
        ? new Date(appRow.proof_captured_at).getTime() - 60000
        : Date.now() - 3 * 60 * 1000);

    const result = await zohoReader.captureConfirmationEmailScreenshot(companyEmail, {
      companyName: appRow.company_name || undefined,
      jobTitle: appRow.job_title || undefined,
      timeoutMs: options.timeoutMs ?? 180000, // 3 minutes default auto capture
      sinceTimestamp,
    });

    if (result.success && result.screenshotBuffer) {
      const capturedAt = new Date().toISOString();
      const emailProofUrl = await uploadEmailProof(storageKey, result.screenshotBuffer);

      await attachEmailProofToApplication(
        appRef,
        emailProofUrl,
        capturedAt
      );

      console.log(
        `[Email Proof] 📧 Successfully captured and uploaded email proof for ${storageKey}: ${emailProofUrl}`
      );
      return emailProofUrl;
    } else {
      console.warn(
        `[Email Proof] ⚠️ Confirmation email not found within timeout for ${storageKey}: ${result.errorMessage}`
      );
      await updateEmailProofStatus(appRef, 'timed_out').catch(() => {});
      return null;
    }
  } catch (err: any) {
    console.error(`[Email Proof] ❌ Background email proof capture error: ${err.message}`);
    await updateEmailProofStatus(appRef, 'timed_out').catch(() => {});
    return null;
  }
}

export const captureProof = captureWebProof;

export default captureWebProof;
