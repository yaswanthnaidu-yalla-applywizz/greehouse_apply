/**
 * @fileoverview FADA (Filtered & Application Diagnostics Analyzer) Engine.
 *
 * Automated diagnostic tool for Production DB2:
 * 1. Filter Diagnostics (fada-filter): Matches original CSV with DB2, identifies FILTERED_OUT
 *    and READY_FOR_REVIEW applications, extracts unresolved and AI-resolved fields, and checks
 *    why fields fell through Tiers 1-4.
 * 2. Failure Diagnostics (fada-failed): Queries all FAILED applications, downloads 100% of
 *    failure screenshots to local disk, creates an inspection manifest, and prepares visual inspection.
 *
 * Usage:
 *   npx tsx .agents/skills/fada/scripts/fada-engine.ts --action=all --csv="path/to/file.csv" --since="2026-11-06"
 *   npx tsx .agents/skills/fada/scripts/fada-engine.ts --action=filter --csv="path/to/file.csv" --since="today"
 *   npx tsx .agents/skills/fada/scripts/fada-engine.ts --action=failed --since="yesterday"
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const DB2_CONNECTION_STRING =
  process.env.DB2_URL ||
  process.env.DATABASE_URL_2 ||
  process.env.DATABASE_URL ||
  'postgresql://postgres.rrqsqakctbrhqcoqavoj:1fs5MGOgMaiuXB16@aws-0-ap-south-1.pooler.supabase.com:5432/postgres';

interface CliArgs {
  action: 'all' | 'filter' | 'failed';
  csvPath?: string;
  since?: string;
  until?: string;
  outDir: string;
  downloadDir?: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let action: 'all' | 'filter' | 'failed' = 'all';
  let csvPath: string | undefined;
  let since: string | undefined;
  let until: string | undefined;
  let outDir = path.resolve(process.cwd(), '.ai', 'diagnostics');
  let downloadDir: string | undefined;

  for (const arg of args) {
    if (arg.startsWith('--action=')) {
      const val = arg.slice('--action='.length).toLowerCase();
      if (val === 'filter' || val === 'failed' || val === 'all') action = val;
    } else if (arg.startsWith('--csv=')) {
      csvPath = arg.slice('--csv='.length).replace(/^["']|["']$/g, '');
    } else if (arg.startsWith('--since=')) {
      since = arg.slice('--since='.length).replace(/^["']|["']$/g, '');
    } else if (arg.startsWith('--until=')) {
      until = arg.slice('--until='.length).replace(/^["']|["']$/g, '');
    } else if (arg.startsWith('--out-dir=')) {
      outDir = path.resolve(arg.slice('--out-dir='.length).replace(/^["']|["']$/g, ''));
    } else if (arg.startsWith('--download-dir=')) {
      downloadDir = path.resolve(arg.slice('--download-dir='.length).replace(/^["']|["']$/g, ''));
    }
  }

  return { action, csvPath, since, until, outDir, downloadDir };
}

/**
 * Resolves date bounds in IST (UTC+5:30) and converts to UTC ISO strings.
 */
function resolveDateBounds(sinceStr?: string, untilStr?: string): { startUtc: string; endUtc?: string; label: string } {
  const now = new Date();
  
  if (!sinceStr || sinceStr === 'today') {
    // Current date in IST
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffsetMs);
    const y = istNow.getUTCFullYear();
    const m = String(istNow.getUTCMonth() + 1).padStart(2, '0');
    const d = String(istNow.getUTCDate()).padStart(2, '0');
    
    // Start of today IST: YYYY-MM-DD 00:00:00 IST -> UTC is previous day 18:30:00Z
    const startIst = new Date(`${y}-${m}-${d}T00:00:00+05:30`);
    return {
      startUtc: startIst.toISOString(),
      label: `Today (IST: ${y}-${m}-${d})`,
    };
  }

  if (sinceStr === 'yesterday') {
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffsetMs);
    const yesterdayIst = new Date(istNow.getTime() - 24 * 60 * 60 * 1000);
    const y = yesterdayIst.getUTCFullYear();
    const m = String(yesterdayIst.getUTCMonth() + 1).padStart(2, '0');
    const d = String(yesterdayIst.getUTCDate()).padStart(2, '0');

    const startIst = new Date(`${y}-${m}-${d}T00:00:00+05:30`);
    const endIst = new Date(`${y}-${m}-${d}T23:59:59.999+05:30`);
    return {
      startUtc: startIst.toISOString(),
      endUtc: endIst.toISOString(),
      label: `Yesterday (IST: ${y}-${m}-${d})`,
    };
  }

  // Check if since is YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(sinceStr)) {
    const startIst = new Date(`${sinceStr}T00:00:00+05:30`);
    let endUtc: string | undefined;
    if (untilStr && /^\d{4}-\d{2}-\d{2}$/.test(untilStr)) {
      endUtc = new Date(`${untilStr}T23:59:59.999+05:30`).toISOString();
    }
    return {
      startUtc: startIst.toISOString(),
      endUtc,
      label: `${sinceStr}${untilStr ? ' to ' + untilStr : ' onwards'}`,
    };
  }

  // Treat as raw ISO string
  const startUtc = new Date(sinceStr).toISOString();
  const endUtc = untilStr ? new Date(untilStr).toISOString() : undefined;
  return {
    startUtc,
    endUtc,
    label: `${sinceStr}${untilStr ? ' to ' + untilStr : ''}`,
  };
}

/**
 * Robust RFC-4180 CSV Parser
 */
function parseCsvFile(filePath: string): Array<Record<string, string>> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines: string[] = [];
  let currentLine = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      currentLine += char;
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && content[i + 1] === '\n') {
        i++;
      }
      if (currentLine.trim()) {
        lines.push(currentLine);
      }
      currentLine = '';
    } else {
      currentLine += char;
    }
  }
  if (currentLine.trim()) {
    lines.push(currentLine);
  }

  if (lines.length < 2) return [];

  function splitLine(line: string): string[] {
    const fields: string[] = [];
    let field = '';
    let inside = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inside && line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inside = !inside;
        }
      } else if (c === ',' && !inside) {
        fields.push(field.trim());
        field = '';
      } else {
        field += c;
      }
    }
    fields.push(field.trim());
    return fields;
  }

  const headers = splitLine(lines[0]).map((h) => h.replace(/^["']|["']$/g, '').trim().toLowerCase());
  const records: Array<Record<string, string>> = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitLine(lines[i]);
    const record: Record<string, string> = {};
    headers.forEach((h, idx) => {
      let val = values[idx] || '';
      if (val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1).replace(/""/g, '"');
      }
      record[h] = val.trim();
    });
    records.push(record);
  }

  return records;
}

/**
 * Strips tracking parameters from Greenhouse/Ashby job URLs.
 */
function normalizeJobUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl.trim());
    u.searchParams.delete('gh_jid');
    u.searchParams.delete('token');
    u.searchParams.delete('utm_source');
    u.searchParams.delete('utm_medium');
    u.searchParams.delete('utm_campaign');
    return u.toString().replace(/\/$/, '');
  } catch {
    return rawUrl.trim().split('?')[0].replace(/\/$/, '');
  }
}

/**
 * Downloads a file via HTTPS/HTTP stream.
 */
function downloadFile(urlStr: string, destPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const client = u.protocol === 'https:' ? https : http;
      const fileStream = fs.createWriteStream(destPath);

      const req = client.get(urlStr, { timeout: 30000 }, (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          res.pipe(fileStream);
          fileStream.on('finish', () => {
            fileStream.close();
            resolve(true);
          });
        } else {
          fileStream.close();
          if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          resolve(false);
        }
      });

      req.on('error', () => {
        fileStream.close();
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        resolve(false);
      });

      req.on('timeout', () => {
        req.destroy();
        fileStream.close();
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

// ============================================================================
// MAIN DIAGNOSTIC WORKFLOWS
// ============================================================================

async function runFilterDiagnostics(
  pool: pg.Pool,
  args: CliArgs,
  dateBounds: { startUtc: string; endUtc?: string; label: string }
) {
  console.log(`\n======================================================`);
  console.log(`🔍 FADA FILTER DIAGNOSTICS`);
  console.log(`   Time Range: ${dateBounds.label}`);
  console.log(`   UTC Bounds: >= ${dateBounds.startUtc}${dateBounds.endUtc ? ' AND < ' + dateBounds.endUtc : ''}`);
  console.log(`======================================================\n`);

  let csvRows: Array<Record<string, string>> = [];
  if (args.csvPath) {
    console.log(`📂 Parsing original CSV: ${args.csvPath}`);
    csvRows = parseCsvFile(args.csvPath);
    console.log(`   Loaded ${csvRows.length} CSV rows.`);
  } else {
    console.log(`⚠️ No CSV path provided. Querying DB applications created in time range directly.`);
  }

  // Query DB applications in date range
  let query = `
    SELECT 
      a.id,
      a.applywizz_id,
      a.job_url,
      a.company_name,
      a.job_title,
      a.status,
      a.resolved_fields,
      a.created_at,
      p.email as candidate_email,
      p.work_authorization,
      p.requires_sponsorship,
      p.country,
      p.location,
      p.phone
    FROM gh_candidate_applications a
    LEFT JOIN profiles p ON p.applywizz_id = a.applywizz_id
    WHERE a.created_at >= $1
  `;
  const params: any[] = [dateBounds.startUtc];

  if (dateBounds.endUtc) {
    query += ` AND a.created_at < $2`;
    params.push(dateBounds.endUtc);
  }
  query += ` ORDER BY a.created_at DESC;`;

  const { rows: dbApps } = await pool.query(query, params);
  console.log(`📊 DB2 Applications found in range: ${dbApps.length}`);

  // Tally status counts
  const statusCounts: Record<string, number> = {};
  for (const app of dbApps) {
    statusCounts[app.status] = (statusCounts[app.status] || 0) + 1;
  }
  console.log('\nStatus Breakdown in Range:');
  for (const [st, cnt] of Object.entries(statusCounts)) {
    console.log(`  - ${st}: ${cnt}`);
  }

  // Filter target applications: FILTERED_OUT and READY_FOR_REVIEW
  const targetApps = dbApps.filter(
    (app) => app.status === 'FILTERED_OUT' || app.status === 'READY_FOR_REVIEW'
  );

  console.log(`\n🎯 Target non-auto-queued applications to diagnose: ${targetApps.length}`);
  console.log(`   - FILTERED_OUT: ${statusCounts['FILTERED_OUT'] || 0}`);
  console.log(`   - READY_FOR_REVIEW: ${statusCounts['READY_FOR_REVIEW'] || 0}`);

  // Inspect resolved_fields
  interface FieldFinding {
    label: string;
    type: string;
    required: boolean;
    source: string;
    value: string;
    appId: string;
    applywizzId: string;
    candidateEmail: string;
    company: string;
    options?: string[];
  }

  interface IncorrectResolvedField {
    appId: string;
    applywizzId: string;
    candidateEmail: string;
    company: string;
    jobTitle: string;
    status: string;
    fieldId: string;
    label: string;
    type: string;
    source: string;
    resolvedValue: string;
    category:
      | 'SPONSORSHIP_INVERSION'
      | 'WORK_AUTH_INVERSION'
      | 'SMS_CONSENT_VIOLATION'
      | 'MANDATORY_TERMS_REJECTION'
      | 'INVALID_CHOICE_OPTION'
      | 'PLACEHOLDER_LEAK'
      | 'CORRUPTED_SENTINEL';
    severity: 'CRITICAL' | 'WARNING';
    groundTruth: string;
    explanation: string;
  }

  function detectIncorrectResolvedField(
    f: any,
    app: any
  ): IncorrectResolvedField | null {
    const val = String(f.value ?? '').trim();
    const lbl = String(f.label || f.name || '').trim();
    const lowerLbl = lbl.toLowerCase();
    const lowerVal = val.toLowerCase();
    const opts = (f.options || []) as string[];
    const type = String(f.type || '').toLowerCase();
    const src = String(f.source || '').toLowerCase();

    // If unresolved or empty, skip (handled by unresolved tracker)
    if (!val || src === 'unresolved') return null;

    // 1. Corrupted / Leaked Sentinel values
    if (
      /^(undefined|null|\[object object\]|nan)$/i.test(val) ||
      (val === '__FILE_UPLOAD__' && type !== 'file')
    ) {
      return {
        appId: app.id,
        applywizzId: app.applywizz_id,
        candidateEmail: app.candidate_email || '',
        company: app.company_name || '',
        jobTitle: app.job_title || '',
        status: app.status,
        fieldId: f.fieldId || f.name,
        label: lbl,
        type,
        source: src,
        resolvedValue: val,
        category: 'CORRUPTED_SENTINEL',
        severity: 'CRITICAL',
        groundTruth: 'Valid user answer or empty string',
        explanation: `Corrupted sentinel or JavaScript object string '${val}' was saved as answer.`,
      };
    }

    // 2. Placeholder Leakage
    if (/^(--\s*select\s*--|select\s*(\.\.\.|an option|one)?|please\s*select|choose\s*an\s*option)$/i.test(val)) {
      return {
        appId: app.id,
        applywizzId: app.applywizz_id,
        candidateEmail: app.candidate_email || '',
        company: app.company_name || '',
        jobTitle: app.job_title || '',
        status: app.status,
        fieldId: f.fieldId || f.name,
        label: lbl,
        type,
        source: src,
        resolvedValue: val,
        category: 'PLACEHOLDER_LEAK',
        severity: 'CRITICAL',
        groundTruth: 'Actual chosen option',
        explanation: `Dropdown placeholder option '${val}' was saved instead of a real selection.`,
      };
    }

    // 3. Invalid Choice / Hallucinated option for Select/Radio
    if ((type === 'select' || type === 'radio') && opts.length > 0) {
      const trimmedOpts = opts.map((o) => o.trim().toLowerCase());
      const matched = trimmedOpts.includes(lowerVal);
      if (!matched) {
        const partialMatch = opts.some(
          (o) => o.toLowerCase().startsWith(lowerVal) || lowerVal.startsWith(o.toLowerCase())
        );
        if (!partialMatch) {
          return {
            appId: app.id,
            applywizzId: app.applywizz_id,
            candidateEmail: app.candidate_email || '',
            company: app.company_name || '',
            jobTitle: app.job_title || '',
            status: app.status,
            fieldId: f.fieldId || f.name,
            label: lbl,
            type,
            source: src,
            resolvedValue: val,
            category: 'INVALID_CHOICE_OPTION',
            severity: 'CRITICAL',
            groundTruth: `Allowed choices: ${opts.slice(0, 4).join(', ')}${opts.length > 4 ? '...' : ''}`,
            explanation: `Populated answer '${val}' does not match any valid option in the form control.`,
          };
        }
      }
    }

    // 4. Visa Sponsorship Contradiction
    if (/sponsorship|require.*sponsor|visa.*status|future.*visa/i.test(lowerLbl)) {
      const isAffirmative = /^(yes|true|affirmative|i will|y)$/i.test(lowerVal);
      const isNegative = /^(no|false|negative|i do not|n)$/i.test(lowerVal);
      const candidateReqSponsorship = app.requires_sponsorship;

      if (candidateReqSponsorship === false && isAffirmative) {
        return {
          appId: app.id,
          applywizzId: app.applywizz_id,
          candidateEmail: app.candidate_email || '',
          company: app.company_name || '',
          jobTitle: app.job_title || '',
          status: app.status,
          fieldId: f.fieldId || f.name,
          label: lbl,
          type,
          source: src,
          resolvedValue: val,
          category: 'SPONSORSHIP_INVERSION',
          severity: 'CRITICAL',
          groundTruth: 'requires_sponsorship = FALSE (Candidate does not need sponsorship)',
          explanation: `Candidate profile has requires_sponsorship = false, but question was answered '${val}' (YES). This misleads the employer into thinking sponsorship is required.`,
        };
      }

      if (candidateReqSponsorship === true && isNegative) {
        return {
          appId: app.id,
          applywizzId: app.applywizz_id,
          candidateEmail: app.candidate_email || '',
          company: app.company_name || '',
          jobTitle: app.job_title || '',
          status: app.status,
          fieldId: f.fieldId || f.name,
          label: lbl,
          type,
          source: src,
          resolvedValue: val,
          category: 'SPONSORSHIP_INVERSION',
          severity: 'CRITICAL',
          groundTruth: 'requires_sponsorship = TRUE (Candidate needs sponsorship)',
          explanation: `Candidate profile has requires_sponsorship = true, but question was answered '${val}' (NO). This is factually inaccurate.`,
        };
      }
    }

    // 5. Work Authorization Contradiction
    if (/authorized\s*to\s*work|legal.*authoriz|eligib.*to\s*work/i.test(lowerLbl)) {
      const isNegative = /^(no|false|negative|i am not|n)$/i.test(lowerVal);
      const workAuth = (app.work_authorization || '').toLowerCase();
      const isAuthorized =
        workAuth.includes('citizen') ||
        workAuth.includes('green card') ||
        workAuth.includes('opt') ||
        workAuth.includes('h1b') ||
        workAuth.includes('ead') ||
        workAuth.includes('authorized');

      if (isAuthorized && isNegative) {
        return {
          appId: app.id,
          applywizzId: app.applywizz_id,
          candidateEmail: app.candidate_email || '',
          company: app.company_name || '',
          jobTitle: app.job_title || '',
          status: app.status,
          fieldId: f.fieldId || f.name,
          label: lbl,
          type,
          source: src,
          resolvedValue: val,
          category: 'WORK_AUTH_INVERSION',
          severity: 'CRITICAL',
          groundTruth: `work_authorization = '${app.work_authorization}' (Legally authorized)`,
          explanation: `Candidate is authorized to work in the US (${app.work_authorization}), but question was answered '${val}' (NO). This leads to immediate rejection.`,
        };
      }
    }

    // 6. SMS / Marketing Consent Violation
    if (
      /sms|text\s*message|whatsapp|marketing\s*(message|communication)|promotional/i.test(lowerLbl) &&
      !/phone\s*number|mobile\s*number/i.test(lowerLbl)
    ) {
      const isAffirmative = /^(yes|true|agree|opt\s*in|checked)$/i.test(lowerVal);
      if (isAffirmative) {
        return {
          appId: app.id,
          applywizzId: app.applywizz_id,
          candidateEmail: app.candidate_email || '',
          company: app.company_name || '',
          jobTitle: app.job_title || '',
          status: app.status,
          fieldId: f.fieldId || f.name,
          label: lbl,
          type,
          source: src,
          resolvedValue: val,
          category: 'SMS_CONSENT_VIOLATION',
          severity: 'WARNING',
          groundTruth: 'System policy: ALWAYS NO / Opt-out for promotional SMS',
          explanation: `Marketing/SMS consent was answered '${val}' (YES). System policy strictly mandates NO to prevent unsolicited messages to the candidate.`,
        };
      }
    }

    // 7. Mandatory Terms / Certification Rejection
    if (
      /i\s*(certify|agree|confirm|acknowledge|declare|accept)|terms\s*(and|&)\s*conditions|privacy\s*policy/i.test(lowerLbl)
    ) {
      const isNegative = /^(no|false|disagree|decline|unchecked)$/i.test(lowerVal);
      if (isNegative) {
        return {
          appId: app.id,
          applywizzId: app.applywizz_id,
          candidateEmail: app.candidate_email || '',
          company: app.company_name || '',
          jobTitle: app.job_title || '',
          status: app.status,
          fieldId: f.fieldId || f.name,
          label: lbl,
          type,
          source: src,
          resolvedValue: val,
          category: 'MANDATORY_TERMS_REJECTION',
          severity: 'CRITICAL',
          groundTruth: 'System policy: Mandatory agreements must be affirmative (YES / Checked)',
          explanation: `Mandatory agreement was answered '${val}' (NO). Answering NO causes instant form validation failure or application rejection.`,
        };
      }
    }

    return null;
  }

  const unresolvedFields: FieldFinding[] = [];
  const aiFields: FieldFinding[] = [];
  const incorrectFields: IncorrectResolvedField[] = [];

  for (const app of targetApps) {
    const fields = (app.resolved_fields || []) as any[];
    for (const f of fields) {
      const isReq = Boolean(f.required);
      const src = (f.source || '').toLowerCase();
      const val = String(f.value || '');
      const item: FieldFinding = {
        label: f.label || f.name || 'Unnamed Field',
        type: f.type || 'text',
        required: isReq,
        source: src,
        value: val,
        appId: app.id,
        applywizzId: app.applywizz_id,
        candidateEmail: app.candidate_email || '',
        company: app.company_name || '',
        options: f.options,
      };

      if (src === 'unresolved' || !val) {
        unresolvedFields.push(item);
      } else if (src === 'ai') {
        aiFields.push(item);
      }

      // Check for incorrect resolved field
      const incorrectCheck = detectIncorrectResolvedField(f, app);
      if (incorrectCheck) {
        incorrectFields.push(incorrectCheck);
      }
    }
  }

  // Frequency aggregation
  function aggregateFields(list: FieldFinding[]) {
    const map = new Map<string, { label: string; type: string; requiredCount: number; optionalCount: number; total: number; sampleCompanies: Set<string> }>();
    for (const item of list) {
      const key = `${item.label.toLowerCase()}|${item.type}`;
      let entry = map.get(key);
      if (!entry) {
        entry = {
          label: item.label,
          type: item.type,
          requiredCount: 0,
          optionalCount: 0,
          total: 0,
          sampleCompanies: new Set(),
        };
        map.set(key, entry);
      }
      entry.total++;
      if (item.required) entry.requiredCount++;
      else entry.optionalCount++;
      if (item.company && entry.sampleCompanies.size < 4) {
        entry.sampleCompanies.add(item.company);
      }
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }

  const aggUnresolved = aggregateFields(unresolvedFields);
  const aggAi = aggregateFields(aiFields);

  // Systematic Tiers Analysis
  // Detect fields that could be resolved by Tiers 1-4
  const potentialTiersRemediations: Array<{
    label: string;
    type: string;
    source: string;
    currentSource: 'unresolved' | 'ai';
    count: number;
    recommendedTier: string;
    reason: string;
  }> = [];

  // Patterns for T1-T4 checks
  for (const agg of [...aggUnresolved, ...aggAi]) {
    const lbl = agg.label.toLowerCase();
    const isAi = aggAi.some((a) => a.label === agg.label);
    const curr: 'unresolved' | 'ai' = isAi ? 'ai' : 'unresolved';

    if (/sponsorship|require.*sponsor|visa|work.*authoriz/i.test(lbl)) {
      potentialTiersRemediations.push({
        label: agg.label,
        type: agg.type,
        source: curr,
        currentSource: curr,
        count: agg.total,
        recommendedTier: 'Tier 1 / Deterministic Policy',
        reason: 'Work authorization and visa sponsorship flags are stored directly in profiles.requiresSponsorship and profiles.workAuthorization. Deterministic choice option matching should resolve this without LLM.',
      });
    } else if (/gender|race|veteran|disability|hispanic|latino/i.test(lbl)) {
      potentialTiersRemediations.push({
        label: agg.label,
        type: agg.type,
        source: curr,
        currentSource: curr,
        count: agg.total,
        recommendedTier: 'Tier 1 / Candidate Demographics',
        reason: 'Demographic responses are populated in profiles.demographics (EEOC). Exact or alias choice mapping can resolve these reliably.',
      });
    } else if (/notice\s*period|available\s*to\s*start|start\s*date/i.test(lbl)) {
      potentialTiersRemediations.push({
        label: agg.label,
        type: agg.type,
        source: curr,
        currentSource: curr,
        count: agg.total,
        recommendedTier: 'Tier 1 Policy Engine',
        reason: 'Availability date policy specifies current date + 7 days (or "Immediately"). Dropdown / text formatters can resolve this directly.',
      });
    } else if (/phone|mobile|cell/i.test(lbl)) {
      potentialTiersRemediations.push({
        label: agg.label,
        type: agg.type,
        source: curr,
        currentSource: curr,
        count: agg.total,
        recommendedTier: 'Tier 2 Parsed Resume / Profile Facts',
        reason: 'Phone numbers reside in parsed resume contact facts or candidate profile. Check if international prefix stripping failed.',
      });
    } else if (/linkedin|github|portfolio|website/i.test(lbl)) {
      potentialTiersRemediations.push({
        label: agg.label,
        type: agg.type,
        source: curr,
        currentSource: curr,
        count: agg.total,
        recommendedTier: 'Tier 1 Profile URL Facts',
        reason: 'Social URLs exist in profile facts. Often left unresolved due to strict URL regex or input field classification.',
      });
    } else if (/education|university|college|school|degree|major|gpa/i.test(lbl)) {
      potentialTiersRemediations.push({
        label: agg.label,
        type: agg.type,
        source: curr,
        currentSource: curr,
        count: agg.total,
        recommendedTier: 'Tier 2 Cached Resume Parse',
        reason: 'Education institutions and degrees are parsed in candidate_resume_parsed. Check if select options were incomplete or unmapped.',
      });
    } else if (/sms|text\s*message|consent|marketing|agree/i.test(lbl)) {
      potentialTiersRemediations.push({
        label: agg.label,
        type: agg.type,
        source: curr,
        currentSource: curr,
        count: agg.total,
        recommendedTier: 'Tier 1 SMS / Consent Policy',
        reason: 'Recruiting SMS opt-in policy resolves to "No" / unchecked. Consent acknowledgments should resolve to affirmative.',
      });
    }
  }

  // Save diagnostic output
  const reportPath = path.resolve(args.outDir, `fada-filter-${Date.now()}.json`);
  fs.mkdirSync(args.outDir, { recursive: true });
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        timeRange: dateBounds,
        csvRowsCount: csvRows.length,
        totalDbApplications: dbApps.length,
        statusBreakdown: statusCounts,
        targetDiagnosedCount: targetApps.length,
        unresolvedFieldsTotal: unresolvedFields.length,
        aiFieldsTotal: aiFields.length,
        incorrectFieldsTotal: incorrectFields.length,
        topUnresolvedQuestions: aggUnresolved.slice(0, 25),
        topAiQuestions: aggAi.slice(0, 25),
        incorrectFields: incorrectFields.slice(0, 50),
        potentialTiersRemediations,
      },
      null,
      2
    )
  );

  console.log(`\n🚨 Incorrectly Answered Resolved Fields Found: ${incorrectFields.length}`);
  if (incorrectFields.length > 0) {
    const byCategory: Record<string, number> = {};
    for (const inc of incorrectFields) {
      byCategory[inc.category] = (byCategory[inc.category] || 0) + 1;
    }
    for (const [cat, cnt] of Object.entries(byCategory)) {
      console.log(`   - ${cat}: ${cnt}`);
    }
  }

  console.log(`\n✅ Filter Diagnostics completed! Summary written to: ${reportPath}`);
  return {
    reportPath,
    aggUnresolved,
    aggAi,
    incorrectFields,
    statusCounts,
    totalTarget: targetApps.length,
    potentialTiersRemediations,
  };
}

async function runFailedDiagnostics(
  pool: pg.Pool,
  args: CliArgs,
  dateBounds: { startUtc: string; endUtc?: string; label: string }
) {
  console.log(`\n======================================================`);
  console.log(`💥 FADA FAILED APPLICATIONS DIAGNOSTICS`);
  console.log(`   Time Range: ${dateBounds.label}`);
  console.log(`   UTC Bounds: >= ${dateBounds.startUtc}${dateBounds.endUtc ? ' AND < ' + dateBounds.endUtc : ''}`);
  console.log(`======================================================\n`);

  let query = `
    SELECT 
      id,
      applywizz_id,
      job_url,
      company_name,
      job_title,
      ats,
      status,
      error_message,
      error_details,
      proof_failed_url,
      retry_count,
      created_at,
      submitted_at
    FROM gh_candidate_applications
    WHERE status = 'FAILED' AND created_at >= $1
  `;
  const params: any[] = [dateBounds.startUtc];

  if (dateBounds.endUtc) {
    query += ` AND created_at < $2`;
    params.push(dateBounds.endUtc);
  }
  query += ` ORDER BY created_at DESC;`;

  const { rows: failedApps } = await pool.query(query, params);
  console.log(`🚨 Total FAILED applications found: ${failedApps.length}`);

  if (failedApps.length === 0) {
    console.log(`✨ No failed applications found in this time range.`);
    return null;
  }

  // Setup download directory
  const safeDateLabel = dateBounds.label.replace(/[^a-zA-Z0-9_-]/g, '_');
  const downloadDir =
    args.downloadDir ||
    path.resolve(process.cwd(), '.ai', 'diagnostics', 'failed_screenshots', safeDateLabel);
  fs.mkdirSync(downloadDir, { recursive: true });

  console.log(`📥 Downloading 100% of failure screenshots to: ${downloadDir}\n`);

  // Download screenshots
  interface DownloadedFailure {
    id: string;
    applywizzId: string;
    company: string;
    title: string;
    ats: string;
    dbErrorMessage: string;
    errorDetails: any;
    proofFailedUrl?: string;
    localScreenshotPath?: string;
    downloadSuccess: boolean;
  }

  const downloadedList: DownloadedFailure[] = [];
  let downloadedCount = 0;
  let missingUrlCount = 0;

  for (let i = 0; i < failedApps.length; i++) {
    const app = failedApps[i];
    const safeCompany = (app.company_name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${app.id}_${safeCompany}.png`;
    const localDest = path.join(downloadDir, filename);

    const record: DownloadedFailure = {
      id: app.id,
      applywizzId: app.applywizz_id,
      company: app.company_name || 'Unknown',
      title: app.job_title || 'Unknown',
      ats: app.ats || 'greenhouse',
      dbErrorMessage: app.error_message || 'No error message',
      errorDetails: app.error_details,
      proofFailedUrl: app.proof_failed_url,
      downloadSuccess: false,
    };

    if (app.proof_failed_url && typeof app.proof_failed_url === 'string') {
      process.stdout.write(`   [${i + 1}/${failedApps.length}] Downloading ${filename}... `);
      const success = await downloadFile(app.proof_failed_url, localDest);
      if (success && fs.existsSync(localDest) && fs.statSync(localDest).size > 1000) {
        record.localScreenshotPath = localDest;
        record.downloadSuccess = true;
        downloadedCount++;
        console.log(`✅ OK (${(fs.statSync(localDest).size / 1024).toFixed(0)} KB)`);
      } else {
        console.log(`❌ Failed download`);
      }
    } else {
      missingUrlCount++;
      console.log(`   [${i + 1}/${failedApps.length}] No proof_failed_url for ${app.id} (${safeCompany})`);
    }

    downloadedList.push(record);
  }

  console.log(`\n📊 Download Summary:`);
  console.log(`   - Total Failed Apps: ${failedApps.length}`);
  console.log(`   - Screenshots Downloaded: ${downloadedCount}`);
  console.log(`   - Missing Proof URL: ${missingUrlCount}`);

  // Raw DB error messages tally
  const rawDbErrors: Record<string, number> = {};
  for (const app of failedApps) {
    const msg = (app.error_message || 'Unknown error').trim().split('\n')[0].slice(0, 100);
    rawDbErrors[msg] = (rawDbErrors[msg] || 0) + 1;
  }

  // Save manifest
  const manifestPath = path.join(downloadDir, 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        timeRange: dateBounds,
        totalFailed: failedApps.length,
        downloadedCount,
        missingUrlCount,
        rawDbErrors,
        applications: downloadedList,
      },
      null,
      2
    )
  );

  console.log(`📋 Manifest written to: ${manifestPath}`);
  console.log(`👁️ Next Step: The agent must inspect the downloaded screenshots using read_file to classify true visual causes.`);

  return {
    downloadDir,
    manifestPath,
    downloadedList,
    totalFailed: failedApps.length,
    downloadedCount,
    rawDbErrors,
  };
}

// ============================================================================
// CLI ENTRYPOINT
// ============================================================================

async function main() {
  const args = parseArgs();
  const dateBounds = resolveDateBounds(args.since, args.until);
  const pool = new Pool({ connectionString: DB2_CONNECTION_STRING, max: 5 });

  try {
    console.log(`🚀 Starting FADA Engine in mode: ${args.action.toUpperCase()}`);

    if (args.action === 'all' || args.action === 'filter') {
      await runFilterDiagnostics(pool, args, dateBounds);
    }

    if (args.action === 'all' || args.action === 'failed') {
      await runFailedDiagnostics(pool, args, dateBounds);
    }

    console.log(`\n🎉 FADA Engine run completed successfully!`);
  } catch (err: any) {
    console.error(`\n❌ Error running FADA Engine:`, err.message || err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
