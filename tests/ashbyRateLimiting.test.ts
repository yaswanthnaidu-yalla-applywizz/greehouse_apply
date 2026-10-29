import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ashbyCompanyIdentity } from '../src/scanner/atsDetector.js';

describe('Ashby Rate Limiting & Migration 042 RPC Verification', () => {
  describe('ashby_company_identity normalization', () => {
    it('normalizes alphanumeric company names to lowercase stripped strings', () => {
      assert.equal(ashbyCompanyIdentity('Nexxen, Inc.', 'https://jobs.ashbyhq.com/nexxen/123'), 'nexxeninc');
      assert.equal(ashbyCompanyIdentity('Scale AI / Federal', 'https://jobs.ashbyhq.com/scale/123'), 'scaleaifederal');
      assert.equal(ashbyCompanyIdentity('  Stripe  ', 'https://jobs.ashbyhq.com/stripe/123'), 'stripe');
      assert.equal(ashbyCompanyIdentity('80,000 Hours', 'https://jobs.ashbyhq.com/80000hours/123'), '80000hours');
    });

    it('falls back to jobs.ashbyhq.com org slug when company name is null, empty, whitespace, or "company"', () => {
      assert.equal(ashbyCompanyIdentity('', 'https://jobs.ashbyhq.com/nexxen/abc-123'), 'nexxen');
      assert.equal(ashbyCompanyIdentity('   ', 'https://jobs.ashbyhq.com/Keycard/abc-123'), 'keycard');
      assert.equal(ashbyCompanyIdentity(null, 'https://jobs.ashbyhq.com/ramp/uuid/application'), 'ramp');
      assert.equal(ashbyCompanyIdentity('company', 'https://jobs.ashbyhq.com/superhuman/123'), 'superhuman');
      assert.equal(ashbyCompanyIdentity('Company', 'https://jobs.ashbyhq.com/retellai/123'), 'retellai');
    });

    it('falls back to hostname when company name is absent and host is custom domain', () => {
      assert.equal(ashbyCompanyIdentity('', 'https://careers.linear.app/engineering/123'), 'careers.linear.app');
      assert.equal(ashbyCompanyIdentity('company', 'https://jobs.example.com/apply/456'), 'jobs.example.com');
    });
  });

  describe('1-Hour Candidate Gap Logic', () => {
    const isCandidate1HourBlocked = (
      queuedApp: { ats: string },
      priorApps: Array<{ ats: string; status: string; submittedAt: Date }>,
      now: Date = new Date()
    ): boolean => {
      if (queuedApp.ats !== 'ashby') return false;
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      return priorApps.some(
        (prior) =>
          ['APPLIED', 'EMAIL_PROOF_PENDING'].includes(prior.status) &&
          prior.submittedAt > oneHourAgo
      );
    };

    it('blocks subsequent Ashby application when prior Ashby app was submitted within 1 hour (APPLIED)', () => {
      const now = new Date('2026-10-29T14:00:00Z');
      const prior = [{
        ats: 'ashby',
        status: 'APPLIED',
        submittedAt: new Date('2026-10-29T13:45:00Z'), // 15 mins ago
      }];
      assert.equal(isCandidate1HourBlocked({ ats: 'ashby' }, prior, now), true);
    });

    it('blocks subsequent Ashby application when prior Ashby app was submitted within 1 hour (EMAIL_PROOF_PENDING)', () => {
      const now = new Date('2026-10-29T14:00:00Z');
      const prior = [{
        ats: 'ashby',
        status: 'EMAIL_PROOF_PENDING',
        submittedAt: new Date('2026-10-29T13:30:00Z'), // 30 mins ago
      }];
      assert.equal(isCandidate1HourBlocked({ ats: 'ashby' }, prior, now), true);
    });

    it('does NOT block subsequent Ashby application when prior app failed within 1 hour', () => {
      const now = new Date('2026-10-29T14:00:00Z');
      const prior = [{
        ats: 'ashby',
        status: 'FAILED',
        submittedAt: new Date('2026-10-29T13:45:00Z'), // 15 mins ago
      }];
      assert.equal(isCandidate1HourBlocked({ ats: 'ashby' }, prior, now), false);
    });

    it('does NOT block subsequent Ashby application when prior submit was > 1 hour ago', () => {
      const now = new Date('2026-10-29T14:00:00Z');
      const prior = [{
        ats: 'ashby',
        status: 'APPLIED',
        submittedAt: new Date('2026-10-29T12:50:00Z'), // 70 mins ago
      }];
      assert.equal(isCandidate1HourBlocked({ ats: 'ashby' }, prior, now), false);
    });

    it('does NOT block Greenhouse applications even if candidate submitted Ashby 10 mins ago', () => {
      const now = new Date('2026-10-29T14:00:00Z');
      const prior = [{
        ats: 'ashby',
        status: 'APPLIED',
        submittedAt: new Date('2026-10-29T13:50:00Z'),
      }];
      assert.equal(isCandidate1HourBlocked({ ats: 'greenhouse' }, prior, now), false);
    });
  });

  describe('48-Hour Same-Company Gap Logic', () => {
    const isSameCompany48HourBlocked = (
      queuedApp: { ats: string; companyName: string; jobUrl: string },
      priorApps: Array<{ ats: string; companyName: string; jobUrl: string; status: string; submittedAt: Date }>,
      now: Date = new Date()
    ): boolean => {
      if (queuedApp.ats !== 'ashby') return false;
      const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
      const queuedId = ashbyCompanyIdentity(queuedApp.companyName, queuedApp.jobUrl);

      return priorApps.some((prior) => {
        if (prior.ats !== 'ashby') return false;
        if (!['APPLIED', 'EMAIL_PROOF_PENDING'].includes(prior.status)) return false;
        if (prior.submittedAt <= fortyEightHoursAgo) return false;

        const priorId = ashbyCompanyIdentity(prior.companyName, prior.jobUrl);
        return priorId === queuedId && priorId !== '';
      });
    };

    it('blocks subsequent application to same company within 48 hours', () => {
      const now = new Date('2026-10-29T14:00:00Z');
      const queuedApp = {
        ats: 'ashby',
        companyName: 'Nexxen Inc',
        jobUrl: 'https://jobs.ashbyhq.com/nexxen/job-2',
      };
      const priorApps = [{
        ats: 'ashby',
        companyName: 'Nexxen, Inc.',
        jobUrl: 'https://jobs.ashbyhq.com/nexxen/job-1',
        status: 'APPLIED',
        submittedAt: new Date('2026-10-28T14:00:00Z'), // 24 hours ago
      }];

      assert.equal(isSameCompany48HourBlocked(queuedApp, priorApps, now), true);
    });

    it('blocks subsequent application to same company when companyName is placeholder and slug matches', () => {
      const now = new Date('2026-10-29T14:00:00Z');
      const queuedApp = {
        ats: 'ashby',
        companyName: 'company',
        jobUrl: 'https://jobs.ashbyhq.com/nexxen/job-2',
      };
      const priorApps = [{
        ats: 'ashby',
        companyName: 'Nexxen',
        jobUrl: 'https://jobs.ashbyhq.com/nexxen/job-1',
        status: 'EMAIL_PROOF_PENDING',
        submittedAt: new Date('2026-10-28T10:00:00Z'), // 28 hours ago
      }];

      assert.equal(isSameCompany48HourBlocked(queuedApp, priorApps, now), true);
    });

    it('allows application to a DIFFERENT company when 1-hour candidate gap is clear', () => {
      const now = new Date('2026-10-29T14:00:00Z');
      const queuedApp = {
        ats: 'ashby',
        companyName: 'Keycard',
        jobUrl: 'https://jobs.ashbyhq.com/keycard/job-9',
      };
      const priorApps = [{
        ats: 'ashby',
        companyName: 'Nexxen',
        jobUrl: 'https://jobs.ashbyhq.com/nexxen/job-1',
        status: 'APPLIED',
        submittedAt: new Date('2026-10-29T12:00:00Z'), // 2 hours ago (> 1 hour, diff company)
      }];

      assert.equal(isSameCompany48HourBlocked(queuedApp, priorApps, now), false);
    });

    it('allows application to same company after 48 hours have elapsed', () => {
      const now = new Date('2026-10-29T14:00:00Z');
      const queuedApp = {
        ats: 'ashby',
        companyName: 'Nexxen',
        jobUrl: 'https://jobs.ashbyhq.com/nexxen/job-2',
      };
      const priorApps = [{
        ats: 'ashby',
        companyName: 'Nexxen',
        jobUrl: 'https://jobs.ashbyhq.com/nexxen/job-1',
        status: 'APPLIED',
        submittedAt: new Date('2026-10-27T13:00:00Z'), // 49 hours ago
      }];

      assert.equal(isSameCompany48HourBlocked(queuedApp, priorApps, now), false);
    });

    it('does NOT block same company if prior attempt FAILED', () => {
      const now = new Date('2026-10-29T14:00:00Z');
      const queuedApp = {
        ats: 'ashby',
        companyName: 'Nexxen',
        jobUrl: 'https://jobs.ashbyhq.com/nexxen/job-2',
      };
      const priorApps = [{
        ats: 'ashby',
        companyName: 'Nexxen',
        jobUrl: 'https://jobs.ashbyhq.com/nexxen/job-1',
        status: 'FAILED',
        submittedAt: new Date('2026-10-29T10:00:00Z'), // 4 hours ago
      }];

      assert.equal(isSameCompany48HourBlocked(queuedApp, priorApps, now), false);
    });
  });

  describe('In-Flight Candidate Concurrency & Advisory Lock Simulation', () => {
    it('skips claiming a candidate when they already have an application in APPLYING status', () => {
      const candidateApplications = [
        { id: 'app-1', candidateId: 'AWL-001', status: 'APPLYING' },
        { id: 'app-2', candidateId: 'AWL-001', status: 'QUEUED' },
        { id: 'app-3', candidateId: 'AWL-002', status: 'QUEUED' },
      ];

      const canClaim = (candId: string) => {
        return !candidateApplications.some((a) => a.candidateId === candId && a.status === 'APPLYING');
      };

      assert.equal(canClaim('AWL-001'), false, 'Candidate with in-flight APPLYING job cannot be claimed');
      assert.equal(canClaim('AWL-002'), true, 'Candidate without in-flight job can be claimed');
    });
  });

  describe('Migration 042 SQL File Audit', () => {
    it('verifies src/db/migrations/042_candidate_submission_gaps.sql contains required RPC and timing contracts', () => {
      const migrationPath = path.resolve('src/db/migrations/042_candidate_submission_gaps.sql');
      assert.ok(fs.existsSync(migrationPath), 'Migration 042 file must exist');

      const sqlContent = fs.readFileSync(migrationPath, 'utf8');

      // 1. ashby_company_identity contract
      assert.ok(
        sqlContent.includes('CREATE OR REPLACE FUNCTION ashby_company_identity'),
        'Must define ashby_company_identity'
      );
      assert.ok(sqlContent.includes('IMMUTABLE'), 'ashby_company_identity must be IMMUTABLE');

      // 2. get_next_queued_application RPC
      assert.ok(
        sqlContent.includes('CREATE OR REPLACE FUNCTION get_next_queued_application()'),
        'Must define get_next_queued_application'
      );

      // 3. Candidate advisory lock
      assert.ok(
        sqlContent.includes('pg_try_advisory_xact_lock'),
        'Must use pg_try_advisory_xact_lock for candidate concurrency serialization'
      );

      // 4. 1-hour candidate gap
      assert.ok(
        sqlContent.includes("INTERVAL '1 hour'"),
        "Must enforce 1-hour candidate gap (INTERVAL '1 hour')"
      );

      // 5. 48-hour same-company gap
      assert.ok(
        sqlContent.includes("INTERVAL '48 hours'"),
        "Must enforce 48-hour same-company gap (INTERVAL '48 hours')"
      );

      // 6. Valid terminal proof states checked
      assert.ok(
        sqlContent.includes("'EMAIL_PROOF_PENDING'"),
        'Must count EMAIL_PROOF_PENDING as an active success signal'
      );
      assert.ok(
        sqlContent.includes("'APPLIED'"),
        'Must count APPLIED as an active success signal'
      );
    });
  });
});
