import type { Request, Response } from 'express';
import { isSupabaseConfigured, getDbClient } from '../db/client.js';
import { parseDashboardStatsRange, serializeDateRange, listIstDatesInclusive } from './dashboardDateRange.js';
import { getISTDateString } from '../services/workHistoryClient.js';
import { countRequiredAiFields, countUnresolvedRequiredFields } from '../resolver/needsReview.js';
import type { IngestFunnelStats } from '../db/funnelStats.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('FilteredStats');

export interface SlimFieldDiagnostic {
  label: string;
  type: string;
  source: string;
  confidence?: number;
  valueSnippet?: string;
  isRequired: boolean;
}

export interface FilteredStatsItem {
  id?: string;
  applywizzId: string;
  companyName: string;
  jobUrl: string;
  jobTitle?: string;
  stage: 'pre_creation' | 'post_creation';
  status: string;
  reason: string;
  unresolvedFields?: SlimFieldDiagnostic[];
  aiFields?: SlimFieldDiagnostic[];
  totalUnresolvedCount?: number;
  totalAiCount?: number;
}

export function extractSlimFieldDiagnostics(fields: any[]): {
  unresolvedFields: SlimFieldDiagnostic[];
  aiFields: SlimFieldDiagnostic[];
  totalUnresolved: number;
  totalAi: number;
} {
  const unresolved: SlimFieldDiagnostic[] = [];
  const ai: SlimFieldDiagnostic[] = [];
  let totalUnresolved = 0;
  let totalAi = 0;

  for (const f of Array.isArray(fields) ? fields : []) {
    const isReq = Boolean(f.isRequired);
    const isValEmpty = f.value == null || String(f.value).trim() === '';
    const isUnres = f.source === 'unresolved' || (!f.source && isReq) || (isReq && isValEmpty);

    const label = String(f.label || f.name || f.fieldId || 'Untitled Field').trim();
    const type = String(f.type || 'text');

    // Sensitive field masking for privacy/PII
    let valStr = f.value != null ? (typeof f.value === 'object' ? JSON.stringify(f.value) : String(f.value)) : '';
    if (/(ssn|social.security|salary|compensation|disability|veteran)/i.test(label)) {
      valStr = '[CONFIDENTIAL / REDACTED]';
    }
    const valueSnippet = valStr ? (valStr.length > 80 ? `${valStr.slice(0, 77)}...` : valStr) : undefined;

    if (isUnres) {
      totalUnresolved++;
      if (unresolved.length < 15) {
        unresolved.push({ label, type, source: 'unresolved', isRequired: isReq });
      }
    } else {
      const isTier5 = f.resolvedByTier === 5 || f.source === 'ai';
      const isLowConf = typeof f.confidence === 'number' && f.confidence < 0.8 && f.source !== 'unresolved';
      if (isTier5 || isLowConf) {
        totalAi++;
        if (ai.length < 15) {
          ai.push({
            label,
            type,
            source: String(f.source || 'ai'),
            confidence: typeof f.confidence === 'number' ? f.confidence : undefined,
            valueSnippet,
            isRequired: isReq,
          });
        }
      }
    }
  }

  return { unresolvedFields: unresolved, aiFields: ai, totalUnresolved, totalAi };
}

export interface BottomFunnelCounts {
  totalTasks: number;
  autoApplied: number;
  readyForReview: number;
  filteredOut: number;
  failed: number;
  queued: number;
}

export function categorizeBottomFunnelCounts(
  apps: Array<{ status?: string | null }>
): BottomFunnelCounts {
  let autoApplied = 0;
  let readyForReview = 0;
  let filteredOut = 0;
  let failed = 0;
  let queued = 0;

  for (const app of apps) {
    const status = (app.status || '').toUpperCase();
    if (status === 'APPLIED' || status === 'EMAIL_PROOF_PENDING') {
      autoApplied++;
    } else if (status === 'READY_FOR_REVIEW') {
      readyForReview++;
    } else if (status === 'FILTERED_OUT' || status === 'SKIPPED') {
      filteredOut++;
    } else if (status === 'FAILED') {
      failed++;
    } else {
      queued++;
    }
  }

  return {
    totalTasks: apps.length,
    autoApplied,
    readyForReview,
    filteredOut,
    failed,
    queued,
  };
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.data;
  }

  set(key: string, data: T, ttlMs = 30000): void {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  clear(): void {
    this.store.clear();
  }
}

export const filteredStatsCache = new TtlCache<any>();

export async function handleFilteredStats(req: Request, res: Response): Promise<void> {
  const parsedRange = parseDashboardStatsRange(req.query as Record<string, unknown>);
  if ('error' in parsedRange) {
    res.status(400).json({ error: parsedRange.error });
    return;
  }

  try {
    const cacheKey = `filtered:${parsedRange.preset}:${parsedRange.fromDate}:${parsedRange.toDate}`;
    const cached = filteredStatsCache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const dates = parsedRange.fromDate && parsedRange.toDate
      ? listIstDatesInclusive(parsedRange.fromDate, parsedRange.toDate)
      : [getISTDateString()];

    const topFunnel = {
      totalCsvRows: 0,
      tasksCreated: 0,
      droppedRows: 0,
      dropReasons: {
        zoho_disconnected: 0,
        job_expired: 0,
        no_scan_template: 0,
        already_applied: 0,
        other: 0,
      } as Record<string, number>,
    };
    const topFunnelDroppedDetails: Array<{
      applywizzId: string;
      companyName: string;
      jobUrl: string;
      reason: string;
    }> = [];
    let hasIngestData = false;

    if (isSupabaseConfigured()) {
      const supabase = getDbClient();
      const keys = dates.map((d) => `ingest_funnel_stats:${d}`);
      const { data: configs } = await supabase
        .from('system_config')
        .select('key, value')
        .in('key', keys);

      if (configs && configs.length > 0) {
        hasIngestData = true;
        for (const row of configs) {
          const stats = row.value as IngestFunnelStats;
          if (!stats) continue;
          topFunnel.totalCsvRows += stats.totalCsvRows || 0;
          topFunnel.tasksCreated += stats.tasksCreated || 0;
          topFunnel.droppedRows += stats.droppedRows || 0;
        topFunnel.dropReasons.zoho_disconnected = (topFunnel.dropReasons.zoho_disconnected || 0) + (Number(stats.dropReasons.zoho_disconnected) || 0);
        topFunnel.dropReasons.job_expired = (topFunnel.dropReasons.job_expired || 0) + (Number(stats.dropReasons.job_expired) || 0);
        topFunnel.dropReasons.no_scan_template = (topFunnel.dropReasons.no_scan_template || 0) + (Number(stats.dropReasons.no_scan_template) || 0);
        topFunnel.dropReasons.security_clearance = (topFunnel.dropReasons.security_clearance || 0) + (Number((stats.dropReasons as any).security_clearance) || 0);
        topFunnel.dropReasons.excluded_company = (topFunnel.dropReasons.excluded_company || 0) + (Number((stats.dropReasons as any).excluded_company) || 0);
        topFunnel.dropReasons.latest_employer = (topFunnel.dropReasons.latest_employer || 0) + (Number((stats.dropReasons as any).latest_employer) || 0);
        topFunnel.dropReasons.already_applied = (topFunnel.dropReasons.already_applied || 0) + (Number(stats.dropReasons.already_applied) || 0);
        topFunnel.dropReasons.exclusions_or_other = (topFunnel.dropReasons.exclusions_or_other || 0) + (Number((stats.dropReasons as any).exclusions_or_other || stats.dropReasons.other) || 0);
        topFunnel.dropReasons.other = topFunnel.dropReasons.exclusions_or_other;
          if (Array.isArray(stats.droppedDetails)) {
            topFunnelDroppedDetails.push(...stats.droppedDetails);
          }
        }
      }
    }

    const bottomFunnel = {
      totalTasks: 0,
      autoApplied: 0,
      readyForReview: 0,
      filteredOut: 0,
      reviewTriggers: {
        has_ai_fields: 0,
        has_unresolved_fields: 0,
        low_confidence: 0,
        mandatory_cover_letter: 0,
        compensation_negative: 0,
      },
      filterTriggers: {
        exceeded_required_unresolved: 0,
        exceeded_required_ai: 0,
      },
    };

    const items: FilteredStatsItem[] = [];

    for (const drop of topFunnelDroppedDetails) {
      items.push({
        applywizzId: drop.applywizzId,
        companyName: drop.companyName,
        jobUrl: drop.jobUrl,
        stage: 'pre_creation',
        status: 'DROPPED',
        reason: drop.reason,
      });
    }

    if (isSupabaseConfigured()) {
      const supabase = getDbClient();
      let allApps: any[] = [];
      let offset = 0;
      const pageSize = 1000;
      const maxRows = 25000;

      while (offset < maxRows) {
        let pageQuery = supabase
          .from('gh_candidate_applications')
          .select('id, applywizz_id, company_name, job_url, job_title, status, resolved_fields, created_at')
          .gte('created_at', parsedRange.startIso);

        if (parsedRange.endIso) {
          pageQuery = pageQuery.lte('created_at', parsedRange.endIso);
        }

        const { data: pageData, error: pageError } = await pageQuery
          .order('created_at', { ascending: false })
          .range(offset, offset + pageSize - 1);

        if (pageError) {
          log.error('Error fetching candidate applications page for filtered stats:', pageError.message);
          break;
        }
        if (!pageData || pageData.length === 0) break;
        allApps.push(...pageData);
        if (pageData.length < pageSize) break;
        offset += pageSize;
      }

      if (allApps.length > 0) {
        const counts = categorizeBottomFunnelCounts(allApps);
        bottomFunnel.totalTasks = counts.totalTasks;
        bottomFunnel.autoApplied = counts.autoApplied;
        bottomFunnel.readyForReview = counts.readyForReview;
        bottomFunnel.filteredOut = counts.filteredOut;

        for (const app of allApps) {
          const status = (app.status || '').toUpperCase();
          const fields = Array.isArray(app.resolved_fields) ? app.resolved_fields : [];

          if (status === 'READY_FOR_REVIEW') {
            let mainReason = 'Operator review required';

            const hasReqCoverLetter = fields.some((f: any) => {
              const combined = `${f.label || ''} ${f.name || ''} ${f.fieldId || ''}`.toLowerCase();
              return Boolean(f.isRequired) && /cover\s*letter|cover_letter/i.test(combined);
            });
            if (hasReqCoverLetter) {
              bottomFunnel.reviewTriggers.mandatory_cover_letter++;
              mainReason = 'Mandatory cover letter required';
            }

            const reqAiCount = countRequiredAiFields(fields);
            if (reqAiCount > 0) {
              bottomFunnel.reviewTriggers.has_ai_fields++;
              if (mainReason === 'Operator review required') {
                mainReason = `${reqAiCount} required field(s) resolved via AI`;
              }
            }

            const reqUnresolvedCount = countUnresolvedRequiredFields(fields);
            if (reqUnresolvedCount > 0) {
              bottomFunnel.reviewTriggers.has_unresolved_fields++;
              if (mainReason === 'Operator review required') {
                mainReason = `${reqUnresolvedCount} required field(s) unresolved`;
              }
            }

            const hasNegativeComp = fields.some((f: any) => {
              const label = (f.label || '').toLowerCase();
              if (/(salary|compensation|expected pay|pay requirement)/i.test(label)) {
                const val = String(f.value || '').trim().toLowerCase();
                return val === 'no' || /^no\b/i.test(val) || val.includes('decline');
              }
              return false;
            });
            if (hasNegativeComp) {
              bottomFunnel.reviewTriggers.compensation_negative++;
              if (mainReason === 'Operator review required') {
                mainReason = 'Negative answer on compensation / salary question';
              }
            }

            const hasLowConfidence = fields.some(
              (f: any) => typeof f.confidence === 'number' && f.confidence < 0.8 && f.source !== 'unresolved'
            );
            if (hasLowConfidence) {
              bottomFunnel.reviewTriggers.low_confidence++;
            }

            const diagnostics = extractSlimFieldDiagnostics(fields);

            items.push({
              id: app.id,
              applywizzId: app.applywizz_id || 'UNKNOWN',
              companyName: app.company_name || 'Unknown Company',
              jobUrl: app.job_url || '',
              jobTitle: app.job_title || undefined,
              stage: 'post_creation',
              status: 'READY_FOR_REVIEW',
              reason: mainReason,
              unresolvedFields: diagnostics.unresolvedFields,
              aiFields: diagnostics.aiFields,
              totalUnresolvedCount: diagnostics.totalUnresolved,
              totalAiCount: diagnostics.totalAi,
            });
          } else if (status === 'FILTERED_OUT' || status === 'SKIPPED') {
            const reqAiCount = countRequiredAiFields(fields);
            const reqUnresolvedCount = countUnresolvedRequiredFields(fields);
            let filterReason = 'Exceeded unresolved or AI field thresholds';

            if (reqUnresolvedCount > 3) {
              bottomFunnel.filterTriggers.exceeded_required_unresolved++;
              filterReason = `Exceeded required unresolved limit (${reqUnresolvedCount} > 3)`;
            } else if (reqAiCount > 3) {
              bottomFunnel.filterTriggers.exceeded_required_ai++;
              filterReason = `Exceeded required AI limit (${reqAiCount} > 3)`;
            }

            const diagnostics = extractSlimFieldDiagnostics(fields);

            items.push({
              id: app.id,
              applywizzId: app.applywizz_id || 'UNKNOWN',
              companyName: app.company_name || 'Unknown Company',
              jobUrl: app.job_url || '',
              jobTitle: app.job_title || undefined,
              stage: 'post_creation',
              status: status,
              reason: filterReason,
              unresolvedFields: diagnostics.unresolvedFields,
              aiFields: diagnostics.aiFields,
              totalUnresolvedCount: diagnostics.totalUnresolved,
              totalAiCount: diagnostics.totalAi,
            });
          }
        }
      }
    }

    for (const drop of topFunnelDroppedDetails) {
      items.push({
        id: `pre_${drop.applywizzId}_${drop.jobUrl}`,
        applywizzId: drop.applywizzId || 'UNKNOWN',
        companyName: drop.companyName || 'Unknown Company',
        jobUrl: drop.jobUrl || '',
        stage: 'pre_creation',
        status: 'DROPPED_PRE_CREATION',
        reason: drop.reason || 'Dropped during CSV ingestion',
      });
    }

    if (!bottomFunnel.totalTasks && topFunnel.tasksCreated) {
      bottomFunnel.totalTasks = topFunnel.tasksCreated;
    }

    const responsePayload = {
      hasIngestData,
      dateRange: serializeDateRange(parsedRange),
      topFunnel,
      bottomFunnel,
      items: items.slice(0, 2000),
    };

    filteredStatsCache.set(cacheKey, responsePayload, 30000);
    res.json(responsePayload);
  } catch (error: any) {
    log.error('filtered-stats failed:', error);
    res.status(500).json({ error: 'Unable to load filtered stats.' });
  }
}
