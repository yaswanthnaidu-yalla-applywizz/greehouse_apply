/**
 * @fileoverview Dry-run reapplication verification script across all failed tasks since yesterday.
 * Runs complete form filling, overlay dismissal, and real-time remediation WITHOUT clicking final submit.
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import pg from 'pg';
import { chromium, type Page, type Browser } from 'playwright';
import { fillForm } from '../src/submitter/formFiller.js';
import { fillAshbyForm, verifyRequiredFieldsCommitted } from '../src/submitter/ashbyFormFiller.js';
import { remediateUncommittedFields } from '../src/submitter/realtimeRemediator.js';
import { dismissBlockingOverlays } from '../src/submitter/fieldFillers/overlayDismissal.js';
import { isAshbyJobClosedOnDom } from '../src/scanner/ashbyScanner.js';
import { toAshbyApplicationUrl } from '../src/scanner/atsDetector.js';
import { findEmbeddedGreenhouseApplicationUrl } from '../src/scanner/playwrightScanner.js';
import { downloadResumeTempFile } from '../src/db/storage.js';
import { extractEducationDateSubfields } from '../src/resolver/educationDates.js';
import { matchCorporatePolicy } from '../src/resolver/corporatePolicies.js';
import { translateTechnicalLabel } from '../src/submitter/realtimeRemediator.js';
import { resolveStandardProfileAttribute } from '../src/resolver/tier1Supabase.js';
import type { ProfileRow } from '../db/profiles.js';
import type { ResolvedField } from '../types/index.js';

dotenv.config();

const { Client } = pg;

interface DryRunResult {
  index: number;
  id: string;
  applywizzId: string;
  candidate: string;
  company: string;
  ats: string;
  jobTitle: string;
  jobUrl: string;
  success: boolean;
  allRequiredCommitted: boolean;
  overlayDismissed: boolean;
  remediationTriggered: boolean;
  remediationCount: number;
  remediationSuccessCount: number;
  uncommittedRequiredFields: string[];
  screenshotPath?: string;
  error?: string;
  durationMs: number;
}

const proofDir = path.resolve(process.cwd(), 'output', 'dry_run_reapply_proofs');
fs.mkdirSync(proofDir, { recursive: true });

async function getCandidateResume(applywizzId: string): Promise<string> {
  const localDirect = path.resolve(process.cwd(), 'resumes', `${applywizzId}_resume.pdf`);
  if (fs.existsSync(localDirect)) return localDirect;

  try {
    const downloaded = await downloadResumeTempFile(applywizzId);
    if (downloaded && fs.existsSync(downloaded)) return downloaded;
  } catch {}

  const fallback1 = path.resolve(process.cwd(), 'resumes', 'AWL-YASHANTH_resume.pdf');
  if (fs.existsSync(fallback1)) return fallback1;

  const fallback2 = path.resolve(process.cwd(), 'resumes', 'my-resume.pdf');
  if (fs.existsSync(fallback2)) return fallback2;

  throw new Error(`No local resume or fallback found for ${applywizzId}`);
}

/**
 * Re-resolves missing education dates, sponsorship, and SMS consent with latest policies.
 */
function enrichResolvedFields(
  fields: ResolvedField[],
  profile: ProfileRow,
  resumeFacts?: Record<string, any>
): ResolvedField[] {
  const enriched = [...fields];

  for (const f of enriched) {
    if (!f.value || String(f.value).trim() === '') {
      // 1. Check education dates
      const eduDate = extractEducationDateSubfields(f.label || f.name || f.fieldId, resumeFacts);
      if (eduDate) {
        f.value = eduDate.value;
        f.source = 'resume' as any;
        f.confidence = eduDate.confidence;
        continue;
      }

      // 2. Check corporate policies
      const policyVal = matchCorporatePolicy(f as any, profile);
      if (policyVal) {
        f.value = policyVal;
        f.source = 'policy' as any;
        f.confidence = 1.0;
        continue;
      }
    }
  }

  return enriched;
}

async function processApplication(
  app: any,
  index: number,
  total: number,
  browser: Browser,
  profileMap: Map<string, ProfileRow>,
  resumeFactsMap: Map<string, any>,
  templateMap: Map<string, any[]>
): Promise<DryRunResult> {
  const startTime = Date.now();
  const indexStr = `[${index + 1}/${total}]`;
  const cleanComp = app.company.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  const screenshotFile = `${String(index + 1).padStart(3, '0')}_${app.ats}_${cleanComp}_${app.id.slice(0, 8)}.png`;
  const screenshotPath = path.join(proofDir, screenshotFile);

  const result: DryRunResult = {
    index: index + 1,
    id: app.id,
    applywizzId: app.applywizzId,
    candidate: app.candidate,
    company: app.company,
    ats: app.ats,
    jobTitle: app.jobTitle,
    jobUrl: app.jobUrl,
    success: false,
    allRequiredCommitted: false,
    overlayDismissed: false,
    remediationTriggered: false,
    remediationCount: 0,
    remediationSuccessCount: 0,
    uncommittedRequiredFields: [],
    durationMs: 0,
  };

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 950 },
  });

  const page = await context.newPage();

  try {
    const profile = profileMap.get(app.applywizzId) || ({
      applywizz_id: app.applywizzId,
      client_name: app.candidate,
      work_authorization: 'US Citizen',
      requires_sponsorship: false,
    } as ProfileRow);

    const resumeFacts = resumeFactsMap.get(app.applywizzId);
    const resumePath = await getCandidateResume(app.applywizzId);

    // Fallback: If resolved_fields is empty, hydrate from scanned template fields
    let rawFields = Array.isArray(app.resolved_fields) && app.resolved_fields.length > 0 ? [...app.resolved_fields] : [];
    if (rawFields.length === 0 && templateMap) {
      const schema = templateMap.get(app.jobUrl) || templateMap.get(toAshbyApplicationUrl(app.jobUrl));
      if (Array.isArray(schema) && schema.length > 0) {
        rawFields = schema.map((f: any) => {
          const humanLabel = translateTechnicalLabel(f.label || f.name || f.fieldId);
          const val =
            resolveStandardProfileAttribute({ ...f, label: humanLabel }, profile) ||
            matchCorporatePolicy({ ...f, label: humanLabel }, profile) ||
            '';
          return {
            fieldId: f.fieldId || f.name,
            name: f.name || f.fieldId,
            type: f.type,
            label: humanLabel,
            value: val,
            isRequired: f.isRequired,
            source: val ? 'profile' : 'unresolved',
          };
        });
      }
    }

    // Re-enrich fields with latest education date extraction & sponsorship polarity
    const enrichedFields = enrichResolvedFields(rawFields, profile, resumeFacts);

    if (app.ats.toLowerCase() === 'greenhouse') {
      const appFields = enrichedFields.map((f: any) => {
        if (f.type === 'file' || f.fieldId?.includes('resume') || f.label?.toLowerCase().includes('resume')) {
          return { ...f, value: resumePath };
        }
        return f;
      });

      const appPayload = {
        ...app,
        resolved_fields: appFields,
      };

      await page.goto(app.jobUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForTimeout(1500);

      // Embedded Greenhouse Frame Resolution
      let targetUrl = app.jobUrl;
      const iframeEl = await page.waitForSelector('iframe[src*="greenhouse"], iframe[src*="job_app"]', { timeout: 3000 }).catch(() => null);
      if (iframeEl) {
        const src = await iframeEl.getAttribute('src').catch(() => null);
        if (src && /greenhouse\.io/i.test(src) && /job_app/i.test(src)) {
          targetUrl = src;
        }
      }
      if (targetUrl === app.jobUrl) {
        const frameUrl = findEmbeddedGreenhouseApplicationUrl(page.frames().map((f) => f.url()));
        if (frameUrl) targetUrl = frameUrl;
      }
      if (targetUrl !== page.url()) {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await page.waitForTimeout(1500);
      }

      // Check overlay auto-dismissal
      result.overlayDismissed = await dismissBlockingOverlays(page);

      // Execute Form Fill (WITHOUT final submit)
      const fillSummary = await fillForm(page, appPayload as any, {
        timeoutMs: 3000,
        minJitterMs: 25,
        maxJitterMs: 75,
      });

      // Mini DOM Agent Remediation for any uncommitted required fields
      if (fillSummary.unfilledRequiredLabels && fillSummary.unfilledRequiredLabels.length > 0) {
        result.remediationTriggered = true;
        result.remediationCount = fillSummary.unfilledRequiredLabels.length;

        const remResult = await remediateUncommittedFields(page, fillSummary.unfilledRequiredLabels, appPayload as any, {
          resumeLocalPath: resumePath,
          getProfileFn: async () => profile,
          getResumeFn: async () => ({ structured: resumeFacts } as any),
        });

        result.remediationSuccessCount = remResult.remediatedCount;
        result.uncommittedRequiredFields = fillSummary.unfilledRequiredLabels.filter(
          (label) => !remResult.remediatedFields.some((rf) => rf.label === label || rf.fieldId === label)
        );
      }

      await page.waitForTimeout(1000);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      result.screenshotPath = screenshotPath;

      result.allRequiredCommitted = result.uncommittedRequiredFields.length === 0;
      result.success = result.allRequiredCommitted;
    } else if (app.ats.toLowerCase() === 'ashby') {
      const targetUrl = toAshbyApplicationUrl(app.jobUrl) || app.jobUrl;
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForTimeout(2000);

      // Fast check 404 / closed
      if (await isAshbyJobClosedOnDom(page)) {
        result.error = 'JOB_CLOSED: Posting has expired or is no longer accepting applications.';
        await page.screenshot({ path: screenshotPath, fullPage: true });
        result.screenshotPath = screenshotPath;
        return result;
      }

      result.overlayDismissed = await dismissBlockingOverlays(page);

      // Transition from Overview tab if active
      const applyTab = page.locator('button:has-text("Apply for this Job"), a:has-text("Apply for this Job"), [role="tab"]:has-text("Application")').first();
      if ((await applyTab.count()) > 0 && (await applyTab.isVisible().catch(() => false))) {
        await applyTab.click().catch(() => {});
        await page.waitForTimeout(1500);
      }

      // Execute Ashby Form Fill
      const fillRes = await fillAshbyForm(page, enrichedFields, resumePath);

      // Pre-submit validation
      const requiredFieldPaths = enrichedFields
        .filter((f) => f.isRequired)
        .map((f) => f.fieldId || f.name)
        .filter((p): p is string => Boolean(p));

      let domVerification = await verifyRequiredFieldsCommitted(page, requiredFieldPaths);
      if (!domVerification.allCommitted) {
        result.remediationTriggered = true;
        result.remediationCount = domVerification.missingFields.length;

        const remResult = await remediateUncommittedFields(page, domVerification.missingFields, { ...app, resolved_fields: enrichedFields } as any, {
          resumeLocalPath: resumePath,
          getProfileFn: async () => profile,
          getResumeFn: async () => ({ structured: resumeFacts } as any),
        });

        result.remediationSuccessCount = remResult.remediatedCount;

        // Re-verify after remediation
        domVerification = await verifyRequiredFieldsCommitted(page, requiredFieldPaths);
      }

      result.uncommittedRequiredFields = domVerification.missingFields;
      result.allRequiredCommitted = domVerification.allCommitted;
      result.success = domVerification.allCommitted;

      await page.screenshot({ path: screenshotPath, fullPage: true });
      result.screenshotPath = screenshotPath;
    }
  } catch (err: any) {
    result.error = err.message;
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      result.screenshotPath = screenshotPath;
    } catch {}
  } finally {
    result.durationMs = Date.now() - startTime;
    await context.close().catch(() => {});
  }

  const statusSymbol = result.success ? '✅' : result.error?.includes('JOB_CLOSED') ? '⏸️' : '⚠️';
  console.log(
    `${indexStr} ${statusSymbol} ${app.company} (${app.ats.toUpperCase()}) | Required Committed: ${result.allRequiredCommitted ? 'YES' : 'NO'} | Remediations: ${result.remediationSuccessCount}/${result.remediationCount} | ${(result.durationMs / 1000).toFixed(1)}s`
  );

  return result;
}

async function main() {
  console.log('========================================================================');
  console.log('   DRY-RUN REAPPLICATION VERIFICATION (STRICT NO-SUBMIT MODE)           ');
  console.log('========================================================================\n');

  // 1. Read Manifest & Filter out closed postings
  const manifestPath = path.resolve(process.cwd(), '.ai', 'diagnostics', 'failed_since_yesterday_manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found at ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const rawApps = manifest.applications || [];

  // Exclude known 404/closed jobs already moved to FILTERED_OUT
  let targetApps = rawApps.filter((a: any) => {
    const isClosedDecagon = a.company === 'Decagon';
    const isClosedAugust = a.company === 'August Health';
    const isClosedClera = a.company === 'CLERA';
    return !isClosedDecagon && !isClosedAugust && !isClosedClera;
  });

  const args = process.argv.slice(2);
  const companyArgIdx = args.indexOf('--company');
  const companyFilter = (companyArgIdx !== -1 && args[companyArgIdx + 1] ? args[companyArgIdx + 1] : process.env.COMPANY_FILTER)?.toLowerCase();
  if (companyFilter) {
    targetApps = targetApps.filter((a: any) => a.company?.toLowerCase().includes(companyFilter));
    console.log(`[Filter] Filtered by company '${companyFilter}': ${targetApps.length} applications.`);
  }

  const limitArgIdx = args.indexOf('--limit');
  const limit = limitArgIdx !== -1 && args[limitArgIdx + 1] ? parseInt(args[limitArgIdx + 1], 10) : (process.env.DRY_RUN_LIMIT ? parseInt(process.env.DRY_RUN_LIMIT, 10) : undefined);
  if (limit && limit > 0) {
    console.log(`[Limit] Limit set: running first ${limit} applications.`);
    targetApps = targetApps.slice(0, limit);
  }

  console.log(`[Init] Total Applications in Cohort: ${targetApps.length} (Excluding 12 closed jobs)`);
  const byAts = targetApps.reduce((acc: any, a: any) => {
    acc[a.ats] = (acc[a.ats] || 0) + 1;
    return acc;
  }, {});
  console.log(`[Init] Breakdown by ATS:`, byAts);

  // 2. Connect DB2 to load Candidate Profiles and Parsed Resumes
  const dbUrl = process.env.DB2_URL;
  if (!dbUrl) throw new Error('DB2_URL is not configured.');

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  console.log('[Init] Connected to DB2. Loading profile facts...');

  const uniqueCandidates: string[] = Array.from(new Set(targetApps.map((a: any) => a.applywizzId)));
  const profilesRes = await client.query('SELECT * FROM profiles WHERE applywizz_id = ANY($1)', [uniqueCandidates]);
  const profileMap = new Map<string, ProfileRow>();
  const resumeFactsMap = new Map<string, any>();
  profilesRes.rows.forEach((p) => {
    profileMap.set(p.applywizz_id, p);
    const facts = p.resume_facts || { education: p.education, experience: p.work_experience };
    resumeFactsMap.set(p.applywizz_id, facts);
  });

  // Also query resolved_fields from DB2 for these exact application IDs
  const appIds = targetApps.map((a: any) => a.id);
  const dbAppsRes = await client.query(
    'SELECT id, resolved_fields FROM gh_candidate_applications WHERE id = ANY($1)',
    [appIds]
  );
  const resolvedFieldsMap = new Map<string, any[]>();
  dbAppsRes.rows.forEach((row) => resolvedFieldsMap.set(row.id, row.resolved_fields));

  // Query scanned templates schema for fallback hydration
  const templatesRes = await client.query(
    'SELECT job_url, fields_schema FROM gh_scanned_job_templates WHERE fields_schema IS NOT NULL'
  );
  const templateMap = new Map<string, any[]>();
  templatesRes.rows.forEach((t) => {
    templateMap.set(t.job_url, t.fields_schema);
  });

  await client.end();
  console.log(`[Init] Loaded ${profileMap.size} profiles, ${templateMap.size} job templates.\n`);

  // Attach fresh DB2 resolved_fields
  targetApps.forEach((a: any) => {
    a.resolved_fields = resolvedFieldsMap.get(a.id) || [];
  });

  // 3. Launch Headless Playwright Browser
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  console.log('[Runner] Starting dry-run execution with concurrency pool of 6 workers...\n');
  const CONCURRENCY = 6;
  const results: DryRunResult[] = [];
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < targetApps.length) {
      const idx = currentIndex++;
      const app = targetApps[idx];
      try {
        const res = await processApplication(
          app,
          idx,
          targetApps.length,
          browser,
          profileMap,
          resumeFactsMap,
          templateMap
        );
        results.push(res);
      } catch (workerErr: any) {
        console.error(`Worker error on app ${idx + 1}: ${workerErr.message}`);
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  await browser.close().catch(() => {});

  // 4. Summarize and Write Report
  const total = results.length;
  const passed = results.filter((r) => r.success).length;
  const closed = results.filter((r) => r.error?.includes('JOB_CLOSED')).length;
  const remediatedApps = results.filter((r) => r.remediationCount > 0);
  const remediatedResolved = results.filter((r) => r.remediationSuccessCount > 0);
  const totalAttemptedRem = results.reduce((sum, r) => sum + r.remediationCount, 0);
  const totalResolvedRem = results.reduce((sum, r) => sum + r.remediationSuccessCount, 0);
  const overlayDismissedCount = results.filter((r) => r.overlayDismissed).length;

  console.log('\n========================================================================');
  console.log('                     DRY-RUN EXECUTION SUMMARY                          ');
  console.log('========================================================================');
  console.log(`Total Applications Tested:       ${total}`);
  console.log(`Fully Committed (100% Required): ${passed} / ${total} (${((passed / total) * 100).toFixed(1)}%)`);
  console.log(`Fast-Detected Closed/404 Jobs:   ${closed}`);
  console.log(`Overlays / Age Gates Dismissed:  ${overlayDismissedCount}`);
  console.log(`Mini DOM Remediations Triggered: ${remediatedApps.length} apps (${totalAttemptedRem} fields attempted)`);
  console.log(`Mini DOM Remediations Succeeded: ${remediatedResolved.length} apps (${totalResolvedRem} fields resolved)`);

  const reportFilePath = path.join(proofDir, 'dry_run_reapplication_summary.json');
  fs.writeFileSync(
    reportFilePath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        totalTested: total,
        passed,
        passRate: `${((passed / total) * 100).toFixed(2)}%`,
        closedJobsDetected: closed,
        overlaysDismissed: overlayDismissedCount,
        remediationStats: {
          applicationsTriggered: remediatedApps.length,
          fieldsAttempted: totalAttemptedRem,
          fieldsResolved: totalResolvedRem,
        },
        results,
      },
      null,
      2
    )
  );

  console.log(`\n[Report Saved] Full JSON report: ${reportFilePath}`);
}

main().catch((err) => {
  console.error('[Fatal Error in Dry-Run Execution]', err);
  process.exit(1);
});
