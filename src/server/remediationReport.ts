/**
 * @fileoverview On-demand reporting and CSV export for real-time form remediation incidents.
 *
 * Extracts what issue the automation faced on live ATS forms and what issue the AI fixed
 * (or why it failed closed) across applications, and streams standard RFC 4180 CSV.
 */

import type { Request, Response } from 'express';
import { getDbClient, isSupabaseConfigured } from '../db/client.js';
import { memoryApplications } from '../db/applications/memoryStore.js';
import { getISTDateRangeUtc } from '../db/applications.js';
import { createLogger } from '../utils/logger.js';
import type { ApplicationRow } from '../db/applications/types.js';

const log = createLogger('RemediationReport');

export interface RemediationExportRow {
  applicationId: string;
  applywizzId: string;
  companyName: string;
  jobTitle: string;
  ats: string;
  applicationStatus: string;
  fieldLabel: string;
  controlType: string;
  outcome: 'resolved' | 'failed_closed';
  issueFaced: string;
  issueFixed: string;
  remediatedValue: string;
  attemptedAt: string;
  jobUrl: string;
}

function escapeCsvCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildRemediationCsv(rows: RemediationExportRow[]): string {
  const headers = [
    'Application ID',
    'ApplyWizz ID',
    'Company',
    'Job Title',
    'ATS',
    'Application Status',
    'Field Label',
    'Control Type',
    'Outcome',
    'Issue Faced',
    'Issue Fixed',
    'Remediated Value',
    'Attempted At',
    'Job URL',
  ];

  const lines = [headers.join(',')];
  for (const r of rows) {
    const line = [
      escapeCsvCell(r.applicationId),
      escapeCsvCell(r.applywizzId),
      escapeCsvCell(r.companyName),
      escapeCsvCell(r.jobTitle),
      escapeCsvCell(r.ats),
      escapeCsvCell(r.applicationStatus),
      escapeCsvCell(r.fieldLabel),
      escapeCsvCell(r.controlType),
      escapeCsvCell(r.outcome),
      escapeCsvCell(r.issueFaced),
      escapeCsvCell(r.issueFixed),
      escapeCsvCell(r.remediatedValue),
      escapeCsvCell(r.attemptedAt),
      escapeCsvCell(r.jobUrl),
    ].join(',');
    lines.push(line);
  }

  return lines.join('\r\n');
}

export function extractRemediationRowsFromApp(
  app: ApplicationRow,
  statusFilter?: 'all' | 'resolved' | 'failed_closed'
): RemediationExportRow[] {
  const rows: RemediationExportRow[] = [];
  const appId = app.id || app.applywizz_id;
  const company = app.company_name || '';
  const title = app.job_title || '';
  const ats = app.ats || (app.job_url.includes('greenhouse.io') ? 'greenhouse' : app.job_url.includes('ashbyhq.com') ? 'ashby' : 'lever');
  const appStatus = app.status;
  const jobUrl = app.job_url || '';

  const report = (app.error_details as any)?.remediationReport;

  // 1. Extract from error_details.remediationReport if present
  if (report && Array.isArray(report.items) && report.items.length > 0) {
    for (const item of report.items) {
      const outcome = item.status === 'resolved' ? 'resolved' : 'failed_closed';
      if (statusFilter && statusFilter !== 'all' && outcome !== statusFilter) {
        continue;
      }
      rows.push({
        applicationId: appId,
        applywizzId: app.applywizz_id,
        companyName: company,
        jobTitle: title,
        ats,
        applicationStatus: appStatus,
        fieldLabel: item.label || item.fieldId || 'Unknown field',
        controlType: item.controlType || 'unknown',
        outcome,
        issueFaced: item.issueFaced || '',
        issueFixed: item.issueFixed || '',
        remediatedValue: item.value || '',
        attemptedAt: item.attemptedAt || report.timestamp || app.updated_at || '',
        jobUrl,
      });
    }
    return rows;
  }

  // 2. Fall back to resolved_fields if remediationReport was not set
  if (Array.isArray(app.resolved_fields)) {
    for (const f of app.resolved_fields) {
      if (f.remediation || f.source === 'ai' || (f as any).source === 'ai_realtime_remediated') {
        const rem = f.remediation;
        const outcome = rem?.status === 'resolved' ? 'resolved' : 'failed_closed';
        if (statusFilter && statusFilter !== 'all' && outcome !== statusFilter) {
          continue;
        }
        rows.push({
          applicationId: appId,
          applywizzId: app.applywizz_id,
          companyName: company,
          jobTitle: title,
          ats,
          applicationStatus: appStatus,
          fieldLabel: f.label || f.fieldId,
          controlType: rem?.controlType || f.type || 'unknown',
          outcome,
          issueFaced: rem?.issueFaced || 'Automation left required field uncommitted on page.',
          issueFixed: rem?.issueFixed || `Resolved to "${f.value}".`,
          remediatedValue: f.value || '',
          attemptedAt: rem?.attemptedAt || app.updated_at || '',
          jobUrl,
        });
      }
    }
  }

  return rows;
}

export async function handleRemediationExport(req: Request, res: Response): Promise<void> {
  const startDateStr = typeof req.query.startDate === 'string' ? req.query.startDate.trim() : '';
  const endDateStr = typeof req.query.endDate === 'string' ? req.query.endDate.trim() : '';
  const atsFilter = typeof req.query.ats === 'string' ? (req.query.ats.trim().toLowerCase() as 'all' | 'greenhouse' | 'ashby' | 'lever') : 'all';
  const statusFilter = typeof req.query.status === 'string' ? (req.query.status.trim().toLowerCase() as 'all' | 'resolved' | 'failed_closed') : 'all';
  const format = typeof req.query.format === 'string' && req.query.format.trim().toLowerCase() === 'json' ? 'json' : 'csv';

  try {
    let applications: ApplicationRow[] = [];

    if (isSupabaseConfigured() && process.env.FORCE_MEMORY_DB !== 'true') {
      try {
        const supabase = getDbClient();
        let query = supabase
          .from('gh_candidate_applications')
          .select('*');

        if (startDateStr) {
          const { startIso } = getISTDateRangeUtc(startDateStr);
          query = query.gte('created_at', startIso);
        }
        if (endDateStr) {
          const { endIso } = getISTDateRangeUtc(endDateStr);
          if (endIso) {
            query = query.lt('created_at', endIso);
          }
        }
        if (atsFilter && atsFilter !== 'all') {
          query = query.eq('ats', atsFilter);
        }

        const { data, error } = await query.order('created_at', { ascending: false }).limit(2000);
        if (error) {
          log.warn('[RemediationExport] Supabase query returned error, falling back to memory store:', error.message);
          applications = Array.from(memoryApplications.values());
        } else {
          applications = (data || []) as ApplicationRow[];
        }
      } catch (sbErr: any) {
        log.warn('[RemediationExport] Supabase query failed, falling back to memory store:', sbErr.message);
        applications = Array.from(memoryApplications.values());
      }
    } else {
      applications = Array.from(memoryApplications.values());
    }

    if (atsFilter && atsFilter !== 'all') {
      applications = applications.filter((a) => (a.ats || '').toLowerCase() === atsFilter);
    }

    const allExportRows: RemediationExportRow[] = [];
    for (const app of applications) {
      const rows = extractRemediationRowsFromApp(app, statusFilter);
      allExportRows.push(...rows);
    }

    if (format === 'json') {
      res.json({
        total: allExportRows.length,
        filters: { startDate: startDateStr, endDate: endDateStr, ats: atsFilter, status: statusFilter },
        rows: allExportRows,
      });
      return;
    }

    const csvData = buildRemediationCsv(allExportRows);
    const filename = `remediation-incidents-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(csvData);
  } catch (err: any) {
    log.error('[RemediationExport] Failed to generate remediation export:', err);
    res.status(500).json({ error: `Failed to export remediation report: ${err.message}` });
  }
}
