/**
 * @fileoverview Count Unique Companies with Automated Job Links in Production (DB2).
 *
 * Computes:
 * 1. Total submitted applications with proof (APPLIED + EMAIL_PROOF_PENDING).
 * 2. Unique employer companies by normalized name (LOWER(TRIM(company_name))).
 * 3. Unique employer companies by ATS domain slug (boards.greenhouse.io/{slug}, jobs.ashbyhq.com/{slug}).
 * 4. Breakdown by submission status (Strict APPLIED vs. EMAIL_PROOF_PENDING).
 * 5. Breakdown by ATS platform (Greenhouse vs. Ashby).
 * 6. Top companies by automated volume.
 *
 * Usage:
 *   npx tsx scripts/countAutomatedCompanies.ts
 *   npx tsx scripts/countAutomatedCompanies.ts --json
 *   npx tsx scripts/countAutomatedCompanies.ts --since=2026-11-01
 *   npx tsx scripts/countAutomatedCompanies.ts --csv=output/companies.csv
 */

import fs from 'fs';
import path from 'path';
import pg from 'pg';
import dotenv from 'dotenv';
import { getFadaDatabaseConnectionString } from '../src/utils/fadaDatabaseConnectionString.js';

dotenv.config();

const { Pool } = pg;

interface CliArgs {
  json: boolean;
  since?: string;
  until?: string;
  csvOut?: string;
}

function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);
  let json = false;
  let since: string | undefined;
  let until: string | undefined;
  let csvOut: string | undefined;

  for (const arg of args) {
    if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--since=')) {
      since = arg.slice('--since='.length).trim();
    } else if (arg.startsWith('--until=')) {
      until = arg.slice('--until='.length).trim();
    } else if (arg.startsWith('--csv=')) {
      csvOut = arg.slice('--csv='.length).trim();
    }
  }

  return { json, since, until, csvOut };
}

export async function countAutomatedCompanies(args: CliArgs = { json: false }) {
  const connectionString = getFadaDatabaseConnectionString(process.env);
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 2,
    connectionTimeoutMillis: 10000,
  });

  const client = await pool.connect();

  try {
    const conditions: string[] = [
      "status IN ('APPLIED', 'EMAIL_PROOF_PENDING')",
      "proof_web_url IS NOT NULL",
    ];
    const params: unknown[] = [];

    if (args.since) {
      params.push(args.since);
      conditions.push(`COALESCE(submitted_at, proof_captured_at, created_at) >= $${params.length}`);
    }
    if (args.until) {
      params.push(args.until);
      conditions.push(`COALESCE(submitted_at, proof_captured_at, created_at) <= $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const summaryQuery = `
      SELECT 
        COUNT(*) as total_submissions,
        COUNT(DISTINCT LOWER(TRIM(company_name))) as unique_companies_by_name,
        COUNT(DISTINCT 
          CASE 
            WHEN job_url LIKE '%greenhouse.io/%' THEN 
              REGEXP_REPLACE(job_url, '^https?://[^/]+/([^/]+)/.*$', '\\1')
            WHEN job_url LIKE '%ashbyhq.com/%' THEN 
              REGEXP_REPLACE(job_url, '^https?://[^/]+/([^/]+)/.*$', '\\1')
            ELSE LOWER(TRIM(company_name))
          END
        ) as unique_companies_by_slug,
        
        -- Status Breakdown
        COUNT(*) FILTER (WHERE status = 'APPLIED') as applied_apps,
        COUNT(DISTINCT LOWER(TRIM(company_name))) FILTER (WHERE status = 'APPLIED') as applied_companies,
        
        COUNT(*) FILTER (WHERE status = 'EMAIL_PROOF_PENDING') as email_pending_apps,
        COUNT(DISTINCT LOWER(TRIM(company_name))) FILTER (WHERE status = 'EMAIL_PROOF_PENDING') as email_pending_companies,

        -- ATS Breakdown
        COUNT(*) FILTER (WHERE ats = 'greenhouse' OR ats IS NULL) as greenhouse_apps,
        COUNT(DISTINCT LOWER(TRIM(company_name))) FILTER (WHERE ats = 'greenhouse' OR ats IS NULL) as greenhouse_companies,

        COUNT(*) FILTER (WHERE ats = 'ashby') as ashby_apps,
        COUNT(DISTINCT LOWER(TRIM(company_name))) FILTER (WHERE ats = 'ashby') as ashby_companies,

        -- Date bounds
        MIN(COALESCE(submitted_at, proof_captured_at, created_at)) as earliest_submission,
        MAX(COALESCE(submitted_at, proof_captured_at, created_at)) as latest_submission
      FROM gh_candidate_applications
      ${whereClause};
    `;

    const summaryRes = await client.query(summaryQuery, params);
    const summary = summaryRes.rows[0];

    // Pipeline Funnel query: Scanned Templates & Total Ingested
    const funnelQuery = `
      SELECT 
        (SELECT COUNT(*) FROM gh_scanned_job_templates) as total_scanned_templates,
        (SELECT COUNT(DISTINCT LOWER(TRIM(company_name))) FROM gh_scanned_job_templates) as unique_scanned_companies,
        (SELECT COUNT(DISTINCT LOWER(TRIM(company_name))) FROM gh_scanned_job_templates WHERE ats = 'greenhouse' OR ats IS NULL) as scanned_greenhouse_companies,
        (SELECT COUNT(DISTINCT LOWER(TRIM(company_name))) FROM gh_scanned_job_templates WHERE ats = 'ashby') as scanned_ashby_companies,
        (SELECT COUNT(*) FROM gh_scanned_job_templates WHERE is_expired = true) as expired_scanned_templates,
        COUNT(*) as total_applications,
        COUNT(DISTINCT LOWER(TRIM(company_name))) as total_companies_in_applications,
        COUNT(DISTINCT LOWER(TRIM(company_name))) FILTER (WHERE status IN ('APPLIED', 'EMAIL_PROOF_PENDING', 'FAILED')) as companies_submission_attempted
      FROM gh_candidate_applications;
    `;
    const funnelRes = await client.query(funnelQuery);
    const funnel = funnelRes.rows[0];

    const topCompaniesQuery = `
      SELECT 
        COALESCE(TRIM(company_name), 'Unknown') as company_name,
        COALESCE(ats, 'greenhouse') as ats,
        COUNT(*) as total_apps,
        COUNT(*) FILTER (WHERE status = 'APPLIED') as applied_count,
        COUNT(*) FILTER (WHERE status = 'EMAIL_PROOF_PENDING') as email_pending_count
      FROM gh_candidate_applications
      ${whereClause}
      GROUP BY company_name, ats
      ORDER BY total_apps DESC
      LIMIT 15;
    `;

    const topCompaniesRes = await client.query(topCompaniesQuery, params);

    const reportData = {
      pipeline_funnel: {
        total_scanned_templates: parseInt(funnel.total_scanned_templates, 10),
        unique_scanned_companies: parseInt(funnel.unique_scanned_companies, 10),
        scanned_greenhouse_companies: parseInt(funnel.scanned_greenhouse_companies, 10),
        scanned_ashby_companies: parseInt(funnel.scanned_ashby_companies, 10),
        expired_scanned_templates: parseInt(funnel.expired_scanned_templates, 10),
        total_candidate_applications: parseInt(funnel.total_applications, 10),
        unique_companies_in_applications: parseInt(funnel.total_companies_in_applications, 10),
        unique_companies_attempted_submission: parseInt(funnel.companies_submission_attempted, 10),
        unique_companies_successfully_submitted: parseInt(summary.unique_companies_by_name, 10),
      },
      summary: {
        total_submissions: parseInt(summary.total_submissions, 10),
        unique_companies_by_name: parseInt(summary.unique_companies_by_name, 10),
        unique_companies_by_slug: parseInt(summary.unique_companies_by_slug, 10),
        status_breakdown: {
          applied: {
            applications: parseInt(summary.applied_apps, 10),
            unique_companies: parseInt(summary.applied_companies, 10),
          },
          email_proof_pending: {
            applications: parseInt(summary.email_pending_apps, 10),
            unique_companies: parseInt(summary.email_pending_companies, 10),
          },
        },
        ats_breakdown: {
          greenhouse: {
            applications: parseInt(summary.greenhouse_apps, 10),
            unique_companies: parseInt(summary.greenhouse_companies, 10),
          },
          ashby: {
            applications: parseInt(summary.ashby_apps, 10),
            unique_companies: parseInt(summary.ashby_companies, 10),
          },
        },
        time_range: {
          earliest: summary.earliest_submission,
          latest: summary.latest_submission,
        },
      },
      top_companies: topCompaniesRes.rows.map((row) => ({
        company_name: row.company_name,
        ats: row.ats,
        total_apps: parseInt(row.total_apps, 10),
        applied_count: parseInt(row.applied_count, 10),
        email_pending_count: parseInt(row.email_pending_count, 10),
      })),
    };

    if (args.csvOut) {
      const allCompaniesQuery = `
        SELECT 
          MIN(TRIM(company_name)) as company_name,
          CASE 
            WHEN MIN(job_url) LIKE '%app.greenhouse.io%' THEN MIN(job_url)
            ELSE REGEXP_REPLACE(MIN(job_url), '^(https?://[^/]+/[^/]+).*$', '\\1')
          END as company_link,
          STRING_AGG(DISTINCT COALESCE(ats, 'greenhouse'), ', ') as ats_platforms,
          COUNT(*) as total_apps
        FROM gh_candidate_applications
        ${whereClause}
        GROUP BY LOWER(TRIM(company_name))
        ORDER BY total_apps DESC, company_name ASC;
      `;
      const allRes = await client.query(allCompaniesQuery, params);
      const csvLines = [
        '# ==============================================================================',
        '# EXECUTIVE SUMMARY: AUTOMATED COMPANIES DIRECTORY (DB2)',
        '# ==============================================================================',
        `# Total Unique Companies Scanned:    ${reportData.pipeline_funnel.unique_scanned_companies} (${reportData.pipeline_funnel.total_scanned_templates} job URLs, ${reportData.pipeline_funnel.expired_scanned_templates} expired)`,
        `#   - Greenhouse Scanned:             ${reportData.pipeline_funnel.scanned_greenhouse_companies} unique companies`,
        `#   - Ashby Scanned:                  ${reportData.pipeline_funnel.scanned_ashby_companies} unique companies`,
        '#',
        `# Total Unique Companies Applied:    ${reportData.summary.unique_companies_by_name} (${reportData.summary.total_submissions} completed web submissions)`,
        `#   - Greenhouse Applied:             ${reportData.summary.ats_breakdown.greenhouse.unique_companies} unique companies (${reportData.summary.ats_breakdown.greenhouse.applications} applications)`,
        `#   - Ashby Applied:                  ${reportData.summary.ats_breakdown.ashby.unique_companies} unique companies (${reportData.summary.ats_breakdown.ashby.applications} applications)`,
        '#',
        '# Submission Status Verification:',
        `#   - Verified Applied:               ${reportData.summary.status_breakdown.applied.unique_companies} unique companies (${reportData.summary.status_breakdown.applied.applications} applications)`,
        `#   - Email Proof Pending:            ${reportData.summary.status_breakdown.email_proof_pending.unique_companies} unique companies (${reportData.summary.status_breakdown.email_proof_pending.applications} applications)`,
        `# Date Coverage:                      ${summary.earliest_submission} to ${summary.latest_submission}`,
        '# ==============================================================================',
        'company_name,company_link,ats',
        ...allRes.rows.map(
          (r) =>
            `"${(r.company_name || 'Unknown').replace(/"/g, '""')}","${(r.company_link || '').replace(/"/g, '""')}","${r.ats_platforms}"`
        ),
      ];
      const targetPath = path.resolve(process.cwd(), args.csvOut);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      try {
        fs.writeFileSync(targetPath, csvLines.join('\n'), 'utf8');
        console.log(`Saved full company breakdown CSV to: ${targetPath}`);
      } catch (err: unknown) {
        const error = err as { code?: string; message?: string };
        if (error.code === 'EBUSY' || error.code === 'EPERM') {
          const fallbackPath = targetPath.replace(/\.csv$/, '_updated.csv');
          fs.writeFileSync(fallbackPath, csvLines.join('\n'), 'utf8');
          console.log(`Target file ${targetPath} is currently locked by another program (e.g. Excel). Saved to: ${fallbackPath}`);
        } else {
          throw err;
        }
      }
    }

    if (args.json) {
      console.log(JSON.stringify(reportData, null, 2));
    } else {
      console.log('\n============================================================');
      console.log('       AUTOMATED JOB LINKS: UNIQUE COMPANIES REPORT (DB2)   ');
      console.log('============================================================\n');
      console.log(`Headline Unique Companies (by Name):  ${reportData.summary.unique_companies_by_name}`);
      console.log(`Headline Unique Companies (by Slug):  ${reportData.summary.unique_companies_by_slug}`);
      console.log(`Total Completed Web Submissions:      ${reportData.summary.total_submissions}`);
      console.log(`Date Coverage:                        ${summary.earliest_submission} to ${summary.latest_submission}\n`);

      console.log('--- Pipeline Funnel ---');
      console.log(`  * Scanned Job Templates:             ${reportData.pipeline_funnel.unique_scanned_companies} unique companies (${reportData.pipeline_funnel.total_scanned_templates} unique job URLs, ${reportData.pipeline_funnel.expired_scanned_templates} expired)`);
      console.log(`  * Ingested Applications:             ${reportData.pipeline_funnel.unique_companies_in_applications} unique companies (${reportData.pipeline_funnel.total_candidate_applications} candidate applications)`);
      console.log(`  * Submissions Attempted:             ${reportData.pipeline_funnel.unique_companies_attempted_submission} unique companies (attempted at least once)`);
      console.log(`  * Successful Web Submissions:        ${reportData.summary.unique_companies_by_name} unique companies (${reportData.summary.total_submissions} submissions with web proof)\n`);

      console.log('--- Breakdown by Status (Submitted) ---');
      console.log(`  * APPLIED (Verified Email/Banner):   ${reportData.summary.status_breakdown.applied.unique_companies} companies (${reportData.summary.status_breakdown.applied.applications} submissions)`);
      console.log(`  * EMAIL_PROOF_PENDING (Web Proof):   ${reportData.summary.status_breakdown.email_proof_pending.unique_companies} companies (${reportData.summary.status_breakdown.email_proof_pending.applications} submissions)\n`);

      console.log('--- Breakdown by ATS ---');
      console.log(`  * Greenhouse:                        ${reportData.summary.ats_breakdown.greenhouse.unique_companies} companies (${reportData.summary.ats_breakdown.greenhouse.applications} submissions)`);
      console.log(`  * Ashby:                             ${reportData.summary.ats_breakdown.ashby.unique_companies} companies (${reportData.summary.ats_breakdown.ashby.applications} submissions)\n`);

      console.log('--- Top 15 Companies by Submissions ---');
      console.table(reportData.top_companies);
      console.log('============================================================\n');
    }

    return reportData;
  } finally {
    client.release();
    await pool.end();
  }
}

// Direct execution CLI entrypoint
const isDirectCli = process.argv[1]?.includes('countAutomatedCompanies');
if (isDirectCli) {
  const cliArgs = parseCliArgs();
  countAutomatedCompanies(cliArgs).catch((err) => {
    console.error('Failed to count automated companies:', err);
    process.exit(1);
  });
}
