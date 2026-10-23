/**
 * @fileoverview Batch Email Proof Fetching & Promotion Script for DB2 (Production).
 *
 * Connects directly to DB2 (Supabase remote Postgres pooler), claims applications
 * currently in EMAIL_PROOF_PENDING status using atomic FOR UPDATE SKIP LOCKED,
 * queries the Zoho Mail REST connector across candidate inboxes with allowHistorical=true,
 * checks for messageId uniqueness to prevent duplicate attachments,
 * and promotes matched applications to APPLIED with email_proof_status = 'verified'.
 *
 * Concurrency: 3 concurrent workers with 500ms pacing.
 *
 * Usage:
 *   npx tsx scripts/fetchEmailProofsDb2.ts
 *   npx tsx scripts/fetchEmailProofsDb2.ts --limit=10
 *   npx tsx scripts/fetchEmailProofsDb2.ts --concurrency=3
 *   npx tsx scripts/fetchEmailProofsDb2.ts --dry-run
 */

import pg from 'pg';
import { queryZohoConfirmationEmail } from '../src/services/inbox/zohoStrategy.js';
import { createLogger } from '../src/utils/logger.js';

const { Pool } = pg;
const log = createLogger('FetchEmailProofsDb2');

const DB2_CONNECTION_STRING =
  process.env.DB2_URL ||
  process.env.DATABASE_URL ||
  'postgresql://postgres.rrqsqakctbrhqcoqavoj:1fs5MGOgMaiuXB16@aws-0-ap-south-1.pooler.supabase.com:5432/postgres';

interface CliArgs {
  concurrency: number;
  limit: number | null;
  dryRun: boolean;
}

function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);
  let concurrency = 3;
  let limit: number | null = null;
  let dryRun = false;

  for (const arg of args) {
    if (arg.startsWith('--concurrency=')) {
      const val = parseInt(arg.slice('--concurrency='.length), 10);
      if (!Number.isNaN(val) && val > 0) concurrency = Math.min(val, 6);
    } else if (arg.startsWith('--limit=')) {
      const val = parseInt(arg.slice('--limit='.length), 10);
      if (!Number.isNaN(val) && val > 0) limit = val;
    } else if (arg === '--dry-run') {
      dryRun = true;
    }
  }

  return { concurrency, limit, dryRun };
}

interface ApplicationToProcess {
  id: string;
  applywizz_id: string;
  company_name: string | null;
  job_url: string;
  submitted_at: string | null;
  proof_captured_at: string | null;
  reviewed_at: string | null;
  created_at: string;
  profile_company_email: string | null;
  profile_email: string | null;
}

export async function claimNextAppFromDb2(pool: pg.Pool): Promise<ApplicationToProcess | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const selectQuery = `
      SELECT 
        ca.id,
        ca.applywizz_id,
        ca.company_name,
        ca.job_url,
        ca.submitted_at,
        ca.proof_captured_at,
        ca.reviewed_at,
        ca.created_at,
        p.company_email AS profile_company_email,
        p.email AS profile_email
      FROM gh_candidate_applications ca
      LEFT JOIN profiles p ON ca.applywizz_id = p.applywizz_id
      WHERE ca.status = 'EMAIL_PROOF_PENDING'
        AND (
          ca.email_proof_status IS NULL
          OR ca.email_proof_status IN ('pending', 'manual_review_needed', 'timed_out', 'queued_retry')
        )
      ORDER BY 
        ca.email_proof_attempted_at ASC NULLS FIRST,
        ca.submitted_at ASC NULLS LAST,
        ca.created_at ASC
      LIMIT 1
      FOR UPDATE OF ca SKIP LOCKED;
    `;

    const res = await client.query(selectQuery);
    if (!res.rows.length) {
      await client.query('ROLLBACK');
      return null;
    }

    const app = res.rows[0] as ApplicationToProcess;

    const updateQuery = `
      UPDATE gh_candidate_applications
      SET email_proof_attempted_at = now(),
          updated_at = now()
      WHERE id = $1;
    `;
    await client.query(updateQuery, [app.id]);
    await client.query('COMMIT');
    return app;
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    log.error(`[DB2] Error claiming application: ${err.message}`);
    return null;
  } finally {
    client.release();
  }
}

async function isMessageIdAlreadyAttached(pool: pg.Pool, messageId: string, currentAppId: string): Promise<boolean> {
  if (!messageId) return false;
  try {
    const res = await pool.query(
      `SELECT id FROM gh_candidate_applications WHERE proof_email_json->>'messageId' = $1 AND id != $2 LIMIT 1`,
      [messageId.trim(), currentAppId]
    );
    return res.rows.length > 0;
  } catch (err: any) {
    log.warn(`[DB2] Error checking messageId uniqueness: ${err.message}`);
    return false;
  }
}

async function promoteAppToApplied(
  pool: pg.Pool,
  appId: string,
  emailJson: any,
  capturedAt: string,
  dryRun: boolean
): Promise<void> {
  if (dryRun) {
    log.info(`[DRY RUN] Would promote app ${appId} to APPLIED with proof subject: "${emailJson.subject}"`);
    return;
  }

  await pool.query(
    `
      UPDATE gh_candidate_applications
      SET status = 'APPLIED',
          email_proof_status = 'captured',
          proof_email_json = $1,
          proof_email_captured_at = $2,
          updated_at = now()
      WHERE id = $3
    `,
    [JSON.stringify(emailJson), capturedAt, appId]
  );
}

async function markAppManualReviewNeeded(pool: pg.Pool, appId: string, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  await pool.query(
    `
      UPDATE gh_candidate_applications
      SET email_proof_status = 'manual_review_needed',
          email_proof_attempted_at = now(),
          updated_at = now()
      WHERE id = $1
    `,
    [appId]
  );
}

async function run(): Promise<void> {
  const { concurrency, limit, dryRun } = parseCliArgs();

  log.info('================================================================');
  log.info(`🚀 Starting Batch Email Proof Fetcher for DB2 (Production)`);
  log.info(`⚙️ Settings: Concurrency=${concurrency} workers | Limit=${limit ?? 'ALL'} | DryRun=${dryRun}`);
  log.info('================================================================');

  const pool = new Pool({
    connectionString: DB2_CONNECTION_STRING,
    ssl: { rejectUnauthorized: false },
    max: concurrency + 2,
  });

  // Check total pending count in DB2
  const countRes = await pool.query(`
    SELECT count(*) AS total_pending
    FROM gh_candidate_applications
    WHERE status = 'EMAIL_PROOF_PENDING'
      AND (
        email_proof_status IS NULL
        OR email_proof_status IN ('pending', 'manual_review_needed', 'timed_out', 'queued_retry')
      );
  `);
  const totalPendingInDb = parseInt(countRes.rows[0].total_pending, 10);
  log.info(`📊 Applications awaiting email proof in DB2: ${totalPendingInDb}`);

  if (totalPendingInDb === 0) {
    log.info('✨ No EMAIL_PROOF_PENDING applications to process. Exiting.');
    await pool.end();
    return;
  }

  let totalClaimed = 0;
  let totalPromoted = 0;
  let totalNotFound = 0;
  let totalDuplicates = 0;
  let totalErrors = 0;
  let isStopping = false;

  const startTime = Date.now();

  const worker = async (workerId: number): Promise<void> => {
    while (!isStopping) {
      if (limit !== null && totalClaimed >= limit) {
        isStopping = true;
        break;
      }

      const app = await claimNextAppFromDb2(pool);
      if (!app) {
        log.info(`[Worker ${workerId}] No more applications to claim. Lane complete.`);
        break;
      }

      totalClaimed++;
      const currentClaimIndex = totalClaimed;
      const appId = app.id;
      const companyName = (app.company_name || '').trim();
      const candidateEmail = (app.profile_company_email || app.profile_email || '').trim().toLowerCase();

      log.info(
        `[Worker ${workerId}] [${currentClaimIndex}/${limit ?? totalPendingInDb}] Inspecting app ${appId.slice(0, 8)} | Cand: ${app.applywizz_id} (${candidateEmail || 'NO_EMAIL'}) | Co: "${companyName || 'NO_COMPANY'}"`
      );

      if (!candidateEmail || !companyName) {
        log.warn(`[Worker ${workerId}] ⚠️ Missing candidateEmail or companyName for ${appId}. Marking manual_review_needed.`);
        await markAppManualReviewNeeded(pool, appId, dryRun);
        totalNotFound++;
        continue;
      }

      const submissionTime = app.submitted_at || app.proof_captured_at || app.reviewed_at || app.created_at;

      try {
        const queryRes = await queryZohoConfirmationEmail({
          candidateEmail,
          companyName,
          submissionTime,
          allowHistorical: true,
          timeoutMs: 30000,
        });

        if (queryRes.matched && queryRes.email) {
          const matchedEmail = queryRes.email;

          // MessageId uniqueness check to prevent duplicate proof attribution
          if (matchedEmail.messageId) {
            const isDuplicate = await isMessageIdAlreadyAttached(pool, matchedEmail.messageId, appId);
            if (isDuplicate) {
              log.warn(
                `[Worker ${workerId}] ⚠️ Email messageId "${matchedEmail.messageId}" already attached to another application. Skipping duplicate.`
              );
              await markAppManualReviewNeeded(pool, appId, dryRun);
              totalDuplicates++;
              continue;
            }
          }

          const capturedAt = matchedEmail.received_at || new Date().toISOString();
          await promoteAppToApplied(pool, appId, matchedEmail, capturedAt, dryRun);
          totalPromoted++;
          log.info(
            `[Worker ${workerId}] 🎉 MATCH CONFIRMED: app ${appId.slice(0, 8)} → APPLIED! Subject: "${matchedEmail.subject}" (${matchedEmail.from})`
          );
        } else {
          await markAppManualReviewNeeded(pool, appId, dryRun);
          totalNotFound++;
          log.info(`[Worker ${workerId}] ℹ️ No match found for app ${appId.slice(0, 8)} (${companyName}).`);
        }
      } catch (err: any) {
        totalErrors++;
        log.error(`[Worker ${workerId}] ❌ Error processing app ${appId.slice(0, 8)}: ${err.message}`);
        await markAppManualReviewNeeded(pool, appId, dryRun).catch(() => {});
      }

      // Pacing delay between queries to protect Zoho REST connector
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };

  // Spawn concurrent workers
  const workerPromises = Array.from({ length: concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workerPromises);

  const durationSec = Math.round((Date.now() - startTime) / 1000);

  log.info('================================================================');
  log.info(`🏁 Batch Processing Completed in ${durationSec}s`);
  log.info(`📊 Summary Report:`);
  log.info(`   • Total Applications Claimed:  ${totalClaimed}`);
  log.info(`   • Promoted to APPLIED:         ${totalPromoted}`);
  log.info(`   • Not Found in Zoho Mail:      ${totalNotFound}`);
  log.info(`   • Duplicate Emails Prevented:  ${totalDuplicates}`);
  log.info(`   • Errors:                      ${totalErrors}`);
  log.info('================================================================');

  await pool.end();
}

run().catch((err) => {
  log.error(`Fatal script error: ${err.message}`, err);
  process.exit(1);
});
