import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runTypedResolutionShadow,
  type ShadowApplicationSnapshot,
  type ShadowAdapters,
} from '../src/resolver/shadowResolution.js';
import type { ProfileRow } from '../src/db/profiles.js';
import type { ScannedJobTemplate } from '../src/types/index.js';

describe('Capability-Free Shadow Resolution Engine', () => {
  const forbiddenAdapters: ShadowAdapters = {
    callLlm: () => {
      throw new Error('FORBIDDEN_CALL: LLM synthesis called in shadow analysis');
    },
    writeQaBank: () => {
      throw new Error('FORBIDDEN_CALL: QA bank writeback called in shadow analysis');
    },
    generateEmbedding: () => {
      throw new Error('FORBIDDEN_CALL: Remote embedding called in shadow analysis');
    },
    writeApplication: () => {
      throw new Error('FORBIDDEN_CALL: Application row write called in shadow analysis');
    },
    writeTemplate: () => {
      throw new Error('FORBIDDEN_CALL: Template write called in shadow analysis');
    },
    enqueue: () => {
      throw new Error('FORBIDDEN_CALL: Enqueue called in shadow analysis');
    },
    updateStatus: () => {
      throw new Error('FORBIDDEN_CALL: Status update called in shadow analysis');
    },
  };

  const sampleTemplate: ScannedJobTemplate = {
    jobUrl: 'https://boards.greenhouse.io/shadow-test/jobs/99901',
    companyName: 'ShadowCorp',
    jobTitle: 'Distributed Systems Engineer',
    scannedAt: new Date().toISOString(),
    isExpired: false,
    jobPostingLocation: 'San Francisco, CA',
    jobPostingFacts: { location: 'San Francisco, CA', locations: ['San Francisco, CA'] },
    fields: [
      {
        fieldId: 'sms',
        name: 'sms_consent',
        type: 'radio',
        label: 'Do you consent to receiving SMS notifications?',
        options: ['Yes', 'No'],
        isRequired: true,
      },
      {
        fieldId: 'office_pref',
        name: 'office_pref',
        type: 'select',
        label: 'Preferred Office Location',
        options: ['San Francisco, CA', 'New York, NY', 'Remote'],
        isRequired: true,
      },
      {
        fieldId: 'creative_story',
        name: 'creative_story',
        type: 'textarea',
        label: 'Tell us about a time you led a large refactoring initiative.',
        isRequired: true,
      },
      {
        fieldId: 'optional_notes',
        name: 'optional_notes',
        type: 'textarea',
        label: 'Any additional notes you would like to share?',
        isRequired: false,
      },
    ],
  };

  const sampleProfile: ProfileRow = {
    applywizz_id: 'AWL-SHADOW-1',
    client_name: 'Alex Engineer',
    email: 'alex@example.com',
    phone: '555-123-4567',
    city: 'San Francisco',
    state: 'CA',
    country: 'United States',
  } as unknown as ProfileRow;

  const snapshot: ShadowApplicationSnapshot = {
    applywizzId: 'AWL-SHADOW-1',
    template: sampleTemplate,
    profile: sampleProfile,
    parsedResume: {
      applywizz_id: 'AWL-SHADOW-1',
      raw_text: 'Alex Engineer | alex@example.com | 555-123-4567',
      structured: { skills: ['Go', 'TypeScript'] },
    } as any,
    qaEntries: [],
    previousStatus: 'READY_FOR_REVIEW',
    previousAutoQueueEligible: false,
  };

  it('runs shadow analysis without invoking any forbidden adapters or writes', async () => {
    const report = await runTypedResolutionShadow([snapshot], forbiddenAdapters);

    assert.equal(report.zeroWritesConfirmed, true);
    assert.equal(report.applicationsCount, 1);
    assert.equal(report.totalFieldsCount, 4);

    // SMS & Office location are deterministic policy hits
    assert.equal(report.deterministicHits, 2);

    // Creative story falls through to Tier 5, recorded as tier5_required
    assert.equal(report.tier5FallthroughCount, 1);

    // Optional field does not block
    assert.equal(report.unresolvedFallthroughCount, 0);

    // Creative field keeps the application in review (not auto-queue eligible)
    assert.equal(report.simulatedAutoQueueEligibleCount, 0);

    // Breakdown by family contains agreement_consent, workplace_preference, creative
    assert.ok(report.byFamily['agreement_consent']);
    assert.equal(report.byFamily['agreement_consent'].deterministic, 1);
    assert.ok(report.byFamily['workplace_preference']);
    assert.equal(report.byFamily['workplace_preference'].deterministic, 1);
    assert.ok(report.byFamily['creative']);
    assert.equal(report.byFamily['creative'].tier5_required, 1);
  });

  it('correctly simulates newly auto-queue eligible applications when all required fields resolve deterministically', async () => {
    const deterministicOnlyTemplate: ScannedJobTemplate = {
      ...sampleTemplate,
      jobUrl: 'https://boards.greenhouse.io/shadow-test/jobs/99902',
      fields: [
        sampleTemplate.fields[0], // SMS (policy)
        sampleTemplate.fields[1], // Office (policy)
        sampleTemplate.fields[3], // Optional field
      ],
    };

    const eligibleSnapshot: ShadowApplicationSnapshot = {
      ...snapshot,
      template: deterministicOnlyTemplate,
      previousAutoQueueEligible: false,
    };

    const report = await runTypedResolutionShadow([eligibleSnapshot], forbiddenAdapters);

    assert.equal(report.deterministicHits, 2);
    assert.equal(report.tier5FallthroughCount, 0);
    assert.equal(report.simulatedAutoQueueEligibleCount, 1);
    assert.equal(report.newlyAutoQueueEligibleCount, 1);
  });
});
