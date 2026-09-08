/**
 * @fileoverview Web Proof Screenshot Capture & Storage Upload (Phase V2-4 / V2-5).
 *
 * Captures full-page confirmation screenshots upon verified submission completion,
 * uploads the buffer to the `proofs_web` Supabase Storage bucket, and records the
 * persistent proof URL and timestamp in `candidate_applications`.
 */

import type { Page } from 'playwright';
import { uploadProof } from '../db/storage.js';
import { setProofUrl } from '../db/applications.js';

export interface ProofCaptureResult {
  proofWebUrl: string;
  proofCapturedAt: string;
  url: string;
  capturedAt: string;
}

/**
 * Captures a full-page screenshot of the confirmed Greenhouse application,
 * uploads it to Supabase Storage, and updates the application database record.
 *
 * @param page - Active Playwright page on the verified confirmation view
 * @param applicationId - Primary UUID identifier of the application record
 * @returns Persistent public proof URL and ISO capture timestamp
 */
export async function captureWebProof(
  page: Page,
  applicationId: string
): Promise<ProofCaptureResult> {
  const capturedAt = new Date().toISOString();

  // 1. Capture full-page screenshot
  const screenshotBuffer = await page.screenshot({
    fullPage: true,
    type: 'png',
  });

  // 2. Upload to Supabase Storage (proofs_web bucket)
  const proofWebUrl = await uploadProof(applicationId, screenshotBuffer);

  // 3. Persist proof URL and timestamp to candidate_applications
  try {
    await setProofUrl(applicationId, proofWebUrl, capturedAt);
    console.log(`[Proof Capture] 📸 Proof screenshot saved for application ${applicationId}: ${proofWebUrl}`);
  } catch (err: any) {
    console.warn(`[Proof Capture] ⚠️ Could not update DB record with proof URL: ${err.message}`);
  }

  return {
    proofWebUrl,
    proofCapturedAt: capturedAt,
    url: proofWebUrl,
    capturedAt,
  };
}

export default captureWebProof;
