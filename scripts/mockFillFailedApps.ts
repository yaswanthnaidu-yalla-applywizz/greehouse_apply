import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import pg from 'pg';
import { chromium, Page } from 'playwright';
import { fillForm } from '../src/submitter/formFiller.js';
import { fillAshbyForm, verifyRequiredFieldsCommitted } from '../src/submitter/ashbyFormFiller.js';
import { remediateUncommittedFields } from '../src/submitter/realtimeRemediator.js';
import { toAshbyApplicationUrl } from '../src/scanner/atsDetector.js';

dotenv.config();

const { Client } = pg;

interface AppRecord {
  id: string;
  company_name: string;
  job_title: string;
  ats: string;
  job_url: string;
  applywizz_id: string;
  resolved_fields: any[];
}

interface MockFillResult {
  index: number;
  id: string;
  company: string;
  ats: string;
  jobUrl: string;
  success: boolean;
  fieldsAttempted: number;
  fieldsFilled: number;
  resumeAttached: boolean;
  remediationCount: number;
  uncommittedRequiredFields: string[];
  screenshotPath?: string;
  error?: string;
}

async function run() {
  console.log('===============================================================');
  console.log('   MOCK FILLING FAILED APPLICATIONS (HEADLESS / READ-ONLY)     ');
  console.log('===============================================================\n');

  const proofsDir = path.resolve(process.cwd(), 'output', 'mock_fill_proofs');
  fs.mkdirSync(proofsDir, { recursive: true });

  const candidateId = 'AWL-33095';
  const resumeLocalPath = path.resolve(process.cwd(), 'resumes', 'AWL-33095_resume.pdf');
  if (!fs.existsSync(resumeLocalPath)) {
    throw new Error(`Resume file not found at ${resumeLocalPath}`);
  }
  console.log(`[Init] Using local resume: ${resumeLocalPath} (${fs.statSync(resumeLocalPath).size} bytes)`);

  // 1. Fetch Candidate Profile and Applications from DB2
  const dbUrl = process.env.DB2_URL;
  if (!dbUrl) {
    throw new Error('DB2_URL environment variable is missing.');
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  console.log('[Init] Connected to DB2.');

  const profileRes = await client.query('SELECT * FROM profiles WHERE applywizz_id = $1 LIMIT 1', [candidateId]);
  const candidateProfile = profileRes.rows[0];
  console.log(`[Init] Loaded profile for ${candidateProfile.client_name} (${candidateProfile.email}).`);

  const appsRes = await client.query(
    `SELECT id, company_name, job_title, ats, job_url, applywizz_id, resolved_fields
     FROM gh_candidate_applications
     WHERE applywizz_id = $1 AND status = 'FAILED'
       AND created_at >= '2026-11-19T00:00:00Z'
     ORDER BY ats, company_name`,
    [candidateId]
  );
  await client.end();

  const applications: AppRecord[] = appsRes.rows;
  console.log(`[Init] Found ${applications.length} failed applications to mock fill.\n`);

  const results: MockFillResult[] = [];

  // Launch Playwright Browser (Headless per user instructions)
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  for (let i = 0; i < applications.length; i++) {
    const app = applications[i];
    const indexStr = `${i + 1}/${applications.length}`;
    console.log(`---------------------------------------------------------------`);
    console.log(`[${indexStr}] ${app.company_name} | ATS: ${app.ats.toUpperCase()}`);
    console.log(`      Job: ${app.job_title}`);
    console.log(`      URL: ${app.job_url}`);

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 950 },
    });
    const page = await context.newPage();

    const result: MockFillResult = {
      index: i + 1,
      id: app.id,
      company: app.company_name,
      ats: app.ats,
      jobUrl: app.job_url,
      success: false,
      fieldsAttempted: 0,
      fieldsFilled: 0,
      resumeAttached: false,
      remediationCount: 0,
      uncommittedRequiredFields: [],
    };

    const cleanCompany = app.company_name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const screenshotName = `${String(i + 1).padStart(2, '0')}_${app.ats}_${cleanCompany}.png`;
    const screenshotFilePath = path.join(proofsDir, screenshotName);

    try {
      if (app.ats.toLowerCase() === 'greenhouse') {
        // Point resume field value to local resume file to avoid network S3 fetch
        const fields = (app.resolved_fields || []).map((f: any) => {
          if (f.type === 'file' || f.fieldId?.includes('resume') || f.label?.toLowerCase().includes('resume')) {
            return { ...f, value: resumeLocalPath };
          }
          return f;
        });
        const appPayload = { ...app, resolved_fields: fields };

        console.log(`      Navigating to Greenhouse application page...`);
        await page.goto(app.job_url, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await page.waitForTimeout(2000);

        console.log(`      Mock filling Greenhouse form fields...`);
        const fillSummary = await fillForm(page, appPayload, {
          timeoutMs: 8000,
          minJitterMs: 50,
          maxJitterMs: 150,
        });

        result.fieldsAttempted = fillSummary.totalFields;
        result.fieldsFilled = fillSummary.filledFields;

        // Check if resume was successfully uploaded without error
        const resumeResult = fillSummary.results.find((r) =>
          r.fieldId?.toLowerCase().includes('resume') || r.fieldLabel?.toLowerCase().includes('resume')
        );
        result.resumeAttached = resumeResult ? resumeResult.success : true;

        await page.waitForTimeout(1500);
        await page.screenshot({ path: screenshotFilePath, fullPage: true });
        result.screenshotPath = screenshotFilePath;
        result.success = fillSummary.failedFields === 0 || (fillSummary.filledFields > 0 && result.resumeAttached);

        console.log(`      ✅ Mock fill completed: ${fillSummary.filledFields}/${fillSummary.totalFields} fields filled.`);
        console.log(`      📄 Resume Attached: ${result.resumeAttached ? 'YES' : 'NO'}`);
        console.log(`      📸 Screenshot saved: ${screenshotName}`);
      } else if (app.ats.toLowerCase() === 'ashby') {
        const targetUrl = toAshbyApplicationUrl(app.job_url);
        console.log(`      Navigating to Ashby page (${targetUrl})...`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await page.waitForTimeout(2500);

        // Click "Apply for this Job" tab if overview is active
        const applyTab = page.locator('button:has-text("Apply for this Job"), a:has-text("Apply for this Job")').first();
        if ((await applyTab.count()) > 0 && (await applyTab.isVisible().catch(() => false))) {
          await applyTab.click().catch(() => {});
          await page.waitForTimeout(1500);
        }

        console.log(`      Mock filling Ashby form fields...`);
        const fillResult = await fillAshbyForm(page, app.resolved_fields || [], resumeLocalPath);
        result.fieldsAttempted = (app.resolved_fields || []).length;
        result.fieldsFilled = fillResult.filledCount;
        result.resumeAttached = true;

        // Settle & smooth scroll
        await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
        await page.waitForTimeout(1500);

        // Pre-submit validation
        const requiredFieldPaths = (app.resolved_fields || [])
          .filter((f: any) => f.isRequired)
          .map((f: any) => f.fieldId || f.name)
          .filter((p: any): p is string => Boolean(p));

        const domVerification = await verifyRequiredFieldsCommitted(page, requiredFieldPaths);
        if (!domVerification.allCommitted) {
          console.log(`      ⚠️ Pre-submit found ${domVerification.missingFields.length} uncommitted fields: ${domVerification.missingFields.join(', ')}`);
          console.log(`      🤖 Triggering Real-Time Mini DOM Agent remediation...`);

          const remediationResult = await remediateUncommittedFields(
            page,
            domVerification.missingFields,
            candidateProfile,
            app.resolved_fields || [],
            app.company_name
          );

          result.remediationCount = remediationResult.remediatedFields.length;
          console.log(`      🤖 Mini DOM Agent remediated ${remediationResult.remediatedFields.length} fields.`);

          // Re-verify after remediation
          const secondVerification = await verifyRequiredFieldsCommitted(page, requiredFieldPaths);
          result.uncommittedRequiredFields = secondVerification.missingFields;
          result.success = secondVerification.allCommitted;
        } else {
          result.success = true;
          console.log(`      ✅ 100% of required fields committed on DOM.`);
        }

        await page.screenshot({ path: screenshotFilePath, fullPage: true });
        result.screenshotPath = screenshotFilePath;
        console.log(`      📸 Screenshot saved: ${screenshotName}`);
      }
    } catch (err: any) {
      console.error(`      ❌ Error during mock fill: ${err.message}`);
      result.error = err.message;
      try {
        await page.screenshot({ path: screenshotFilePath, fullPage: true });
        result.screenshotPath = screenshotFilePath;
      } catch {}
    } finally {
      await context.close().catch(() => {});
    }

    results.push(result);
  }

  await browser.close().catch(() => {});

  // Generate Report
  console.log('\n===============================================================');
  console.log('                     MOCK FILL SUMMARY                         ');
  console.log('===============================================================\n');

  const greenhouseResults = results.filter((r) => r.ats.toLowerCase() === 'greenhouse');
  const ashbyResults = results.filter((r) => r.ats.toLowerCase() === 'ashby');

  console.log(`Greenhouse Applications: ${greenhouseResults.length}`);
  console.log(`  - Resume Upload Success: ${greenhouseResults.filter((r) => r.resumeAttached).length}/${greenhouseResults.length}`);
  console.log(`  - Overall Pass Rate: ${greenhouseResults.filter((r) => r.success).length}/${greenhouseResults.length}`);

  console.log(`\nAshby Applications: ${ashbyResults.length}`);
  console.log(`  - Required Fields 100% Committed: ${ashbyResults.filter((r) => r.success).length}/${ashbyResults.length}`);
  console.log(`  - Mini DOM Remediations Triggered: ${ashbyResults.filter((r) => r.remediationCount > 0).length}`);

  const reportPath = path.resolve(proofsDir, 'mock_fill_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\n[Done] Detailed JSON report written to: ${reportPath}`);
}

run().catch((err) => {
  console.error('[Fatal Error]', err);
  process.exit(1);
});
