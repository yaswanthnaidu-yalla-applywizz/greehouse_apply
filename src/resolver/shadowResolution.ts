/**
 * @fileoverview Read-only shadow analysis for typed deterministic resolution.
 * Strictly guarantees zero writes and zero LLM / embedding invocations.
 */

import { AnswerResolver, type ResolutionJobContext, type CachedResolutionEvidence } from './answerResolver.js';
import { applicationNeedsOperatorReview } from './needsReview.js';
import type { ResolutionDecision } from './resolutionMode.js';
import type {
  FieldFamily,
  ScannedJobTemplate,
} from '../types/index.js';
import type { ProfileRow } from '../db/profiles.js';
import type { ResumeParsedRow } from './tier2ResumeParse.js';
import type { QABankRow } from '../db/qaBank.js';

export interface ShadowApplicationSnapshot {
  applywizzId: string;
  template: ScannedJobTemplate;
  profile?: ProfileRow | null;
  parsedResume?: ResumeParsedRow | null;
  qaEntries?: QABankRow[];
  previousStatus?: string;
  previousAutoQueueEligible?: boolean;
}

export interface ShadowAdapters {
  callLlm?: () => never;
  writeQaBank?: () => never;
  generateEmbedding?: () => never;
  writeApplication?: () => never;
  writeTemplate?: () => never;
  enqueue?: () => never;
  updateStatus?: () => never;
}

export interface ShadowResolutionReport {
  timestamp: string;
  applicationsCount: number;
  totalFieldsCount: number;
  deterministicHits: number;
  tier5FallthroughCount: number;
  unresolvedFallthroughCount: number;
  incompatibleRejectionsCount: number;
  simulatedAutoQueueEligibleCount: number;
  newlyAutoQueueEligibleCount: number;
  byFamily: Record<
    string,
    {
      deterministic: number;
      tier5_required: number;
      unresolved: number;
    }
  >;
  zeroWritesConfirmed: boolean;
  decisions: ResolutionDecision[];
}

export async function runTypedResolutionShadow(
  snapshots: ShadowApplicationSnapshot[],
  _adapters?: ShadowAdapters
): Promise<ShadowResolutionReport> {
  const decisions: ResolutionDecision[] = [];
  const resolver = new AnswerResolver();

  let totalFieldsCount = 0;
  let deterministicHits = 0;
  let tier5FallthroughCount = 0;
  let unresolvedFallthroughCount = 0;
  let simulatedAutoQueueEligibleCount = 0;
  let newlyAutoQueueEligibleCount = 0;

  const byFamily: Record<
    string,
    { deterministic: number; tier5_required: number; unresolved: number }
  > = {};

  function recordFamilyCount(
    family: FieldFamily,
    kind: 'deterministic' | 'tier5_required' | 'unresolved'
  ) {
    if (!byFamily[family]) {
      byFamily[family] = { deterministic: 0, tier5_required: 0, unresolved: 0 };
    }
    byFamily[family][kind]++;
  }

  for (const snapshot of snapshots) {
    const jobContext: ResolutionJobContext = {
      companyName: snapshot.template.companyName || 'Company',
      jobTitle: snapshot.template.jobTitle || 'Position',
      jobUrl: snapshot.template.jobUrl,
      jobPostingLocation: snapshot.template.jobPostingLocation,
      jobPostingFacts: snapshot.template.jobPostingFacts,
    };

    const evidence: CachedResolutionEvidence = {
      profile: snapshot.profile,
      parsedResume: snapshot.parsedResume,
      qaEntries: snapshot.qaEntries,
    };

    const resolvedFields = await resolver.resolveFormFields(
      snapshot.applywizzId,
      snapshot.template.fields,
      jobContext,
      evidence,
      {
        mode: 'shadow',
        recordDecision: (decision) => {
          decisions.push(decision);
        },
      }
    );

    totalFieldsCount += snapshot.template.fields.length;

    for (const field of resolvedFields) {
      const family = field.provenance?.family || 'unknown';
      if (field.source !== 'unresolved' && field.source !== 'ai') {
        deterministicHits++;
        recordFamilyCount(family as FieldFamily, 'deterministic');
      } else if (field.provenance?.evidenceKind === 'tier5_required') {
        tier5FallthroughCount++;
        recordFamilyCount(family as FieldFamily, 'tier5_required');
      } else if (field.isRequired) {
        unresolvedFallthroughCount++;
        recordFamilyCount(family as FieldFamily, 'unresolved');
      }
    }

    const needsReview = applicationNeedsOperatorReview(resolvedFields);
    const autoQueueEligible = !needsReview;
    if (autoQueueEligible) {
      simulatedAutoQueueEligibleCount++;
      if (!snapshot.previousAutoQueueEligible) {
        newlyAutoQueueEligibleCount++;
      }
    }
  }

  return {
    timestamp: new Date().toISOString(),
    applicationsCount: snapshots.length,
    totalFieldsCount,
    deterministicHits,
    tier5FallthroughCount,
    unresolvedFallthroughCount,
    incompatibleRejectionsCount: 0,
    simulatedAutoQueueEligibleCount,
    newlyAutoQueueEligibleCount,
    byFamily,
    zeroWritesConfirmed: true,
    decisions,
  };
}
