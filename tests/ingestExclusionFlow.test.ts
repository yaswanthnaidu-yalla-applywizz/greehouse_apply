import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ApplyWizzCandidateProfile, CandidateJobApplication, CandidateSegment, ScannedJobTemplate } from '../src/types/index.js';
import { AnswerResolver } from '../src/resolver/answerResolver.js';
import { renderIngestFilterReportCsv } from '../src/scanner/ingestFilterReport.js';
import { exportScannedJobs } from '../src/scanner/exportScannedJobs.js';
import { hasSecurityClearanceQuestion } from '../src/scanner/securityClearance.js';

const { upsertRows } = vi.hoisted(() => ({ upsertRows: vi.fn() }));

vi.mock('../src/db/client.js', () => ({
  getDbClient: () => ({
    from: () => ({
      upsert: (rows: unknown[]) => {
        upsertRows(rows);
        return { then: (resolve: (value: { error: null }) => unknown) => resolve({ error: null }) };
      },
    }),
  }),
  isSupabaseConfigured: () => true,
}));

vi.mock('../src/db/sandboxClient.js', () => ({ isSandboxMode: () => true }));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  upsertRows.mockReset();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function template(jobUrl: string, label: string, companyName = 'Example Corp'): ScannedJobTemplate {
  return {
    jobUrl,
    companyName,
    jobTitle: 'Engineer',
    fields: [{
      fieldId: 'custom_question',
      name: 'custom_question',
      type: 'text',
      label,
      isRequired: false,
    }],
    scannedAt: '2026-10-15T00:00:00.000Z',
    isExpired: false,
  };
}

function profile(overrides: Partial<ApplyWizzCandidateProfile> = {}): ApplyWizzCandidateProfile {
  return {
    applywizzId: 'AWL-1',
    clientName: 'Candidate One',
    firstName: 'Candidate',
    lastName: 'One',
    email: 'candidate@example.com',
    phone: '',
    location: '',
    linkedinUrl: '',
    workAuthorization: '',
    requiresSponsorship: false,
    education: [],
    workExperience: [],
    resumeUrl: '',
    localResumePath: '',
    ...overrides,
  };
}

function segment(
  candidateProfile: ApplyWizzCandidateProfile,
  jobs?: CandidateSegment['jobs']
): CandidateSegment {
  return {
    applywizzId: candidateProfile.applywizzId,
    clientName: candidateProfile.clientName,
    profile: candidateProfile,
    jobs: jobs || [{
      rawUrl: 'https://boards.greenhouse.io/example/jobs/1',
      canonicalUrl: 'https://boards.greenhouse.io/example/jobs/1',
      date: '2026-10-15',
      score: '',
      scoredJobId: '',
      status: 'PENDING',
    }],
    totalJobs: 1,
    syncedAt: '2026-10-15T00:00:00.000Z',
  };
}

function resolvedApplication(jobUrl: string): CandidateJobApplication {
  return {
    applywizzId: 'AWL-1',
    candidateName: 'Candidate One',
    jobUrl,
    companyName: 'Example Corp',
    jobTitle: 'Engineer',
    status: 'READY_FOR_REVIEW',
    resolvedFields: [],
  };
}

describe('ingestion exclusion flow', () => {
  it('does not upsert clearance templates to scanned job templates', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ingest-exclusion-'));
    temporaryDirectories.push(outputDir);
    const clearance = template('https://boards.greenhouse.io/example/jobs/1', 'Security clearance eligibility');
    const eligible = template('https://boards.greenhouse.io/example/jobs/2', 'Years of experience');

    await exportScannedJobs([clearance, eligible], outputDir);

    expect(upsertRows).toHaveBeenCalledOnce();
    expect(upsertRows.mock.calls[0][0]).toEqual([
      expect.objectContaining({ job_url: eligible.jobUrl }),
    ]);
  });

  it('skips clearance jobs before answer resolution and emits no application', async () => {
    const resolver = new AnswerResolver();
    const resolveSpy = vi.spyOn(resolver, 'resolveJobApplication')
      .mockResolvedValue(resolvedApplication('https://boards.greenhouse.io/example/jobs/1'));
    const scanned = template('https://boards.greenhouse.io/example/jobs/1', 'Are you eligible for a security clearance?');

    const result = await resolver.resolveAllApplications([segment(profile())], [scanned]);

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('skips company-excluded applications before resolution and emits both matching reasons', async () => {
    const resolver = new AnswerResolver();
    const resolveSpy = vi.spyOn(resolver, 'resolveJobApplication')
      .mockResolvedValue(resolvedApplication('https://boards.greenhouse.io/example/jobs/1'));
    const onFilteredApplication = vi.fn();
    const candidateProfile = profile({
      raw_api_payload: {
        additional_information: { exclude_companies: '["Example Corp"]' },
      },
      resumeFacts: {
        experience: [{ company: 'Example Corp', startDate: '2022-01', endDate: 'Present' }],
      },
    });
    const scanned = template('https://boards.greenhouse.io/example/jobs/1', 'Years of experience', ' example   corp ');

    const result = await resolver.resolveAllApplications(
      [segment(candidateProfile)],
      [scanned],
      { onFilteredApplication }
    );

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(result).toEqual([]);
    expect(onFilteredApplication.mock.calls).toEqual([
      [{ applywizzId: 'AWL-1', jobUrl: scanned.jobUrl }, 'excluded_company'],
      [{ applywizzId: 'AWL-1', jobUrl: scanned.jobUrl }, 'latest_employer'],
    ]);
  });

  it('continues resolving applications with no exclusion match', async () => {
    const resolver = new AnswerResolver();
    const application = resolvedApplication('https://boards.greenhouse.io/example/jobs/1');
    const resolveSpy = vi.spyOn(resolver, 'resolveJobApplication').mockResolvedValue(application);

    const result = await resolver.resolveAllApplications(
      [segment(profile())],
      [template(application.jobUrl, 'Years of experience')]
    );

    expect(resolveSpy).toHaveBeenCalledOnce();
    expect(result).toEqual([application]);
  });

  it('filters clearance and both company rules while reporting the eligible scanned application flow', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ingest-exclusion-e2e-'));
    temporaryDirectories.push(outputDir);
    const clearanceUrl = 'https://boards.greenhouse.io/example/jobs/clearance';
    const excludedUrl = 'https://boards.greenhouse.io/example/jobs/excluded';
    const eligibleUrl = 'https://boards.greenhouse.io/example/jobs/eligible';
    const templates = [
      template(clearanceUrl, 'Security clearance required', 'Clearance Corp'),
      template(excludedUrl, 'Years of experience', 'Example Corp'),
      template(eligibleUrl, 'Years of experience', 'Different Corp'),
    ];
    const candidateProfile = profile({
      raw_api_payload: {
        additional_information: { exclude_companies: '["Example Corp"]' },
      },
      resumeFacts: {
        experience: [{ company: 'Example Corp', startDate: '2022-01', endDate: 'Present' }],
      },
    });
    const jobs: CandidateSegment['jobs'] = templates.map(({ jobUrl }) => ({
      rawUrl: jobUrl,
      canonicalUrl: jobUrl,
      date: '2026-10-15',
      score: '',
      scoredJobId: '',
      status: 'PENDING',
    }));
    const clearanceLinks = templates.filter(hasSecurityClearanceQuestion).map(({ jobUrl }) => jobUrl);
    const filtered: Array<{ applywizzId: string; jobUrl: string; reason: string }> = [];

    await exportScannedJobs(templates, outputDir);

    const resolver = new AnswerResolver();
    const eligibleApplication = resolvedApplication(eligibleUrl);
    const resolveSpy = vi.spyOn(resolver, 'resolveJobApplication').mockResolvedValue(eligibleApplication);
    const resolved = await resolver.resolveAllApplications(
      [segment(candidateProfile, jobs)],
      templates,
      {
        onFilteredApplication: (application, reason) => filtered.push({ ...application, reason }),
      }
    );
    const report = {
      clearanceLinks,
      excludedCompanyApplications: filtered
        .filter(({ reason }) => reason === 'excluded_company')
        .map(({ applywizzId, jobUrl }) => ({ applywizzId, jobUrl })),
      latestEmployerApplications: filtered
        .filter(({ reason }) => reason === 'latest_employer')
        .map(({ applywizzId, jobUrl }) => ({ applywizzId, jobUrl })),
    };

    expect(upsertRows.mock.calls[0][0]).toEqual([
      expect.objectContaining({ job_url: excludedUrl }),
      expect.objectContaining({ job_url: eligibleUrl }),
    ]);
    expect(resolveSpy).toHaveBeenCalledOnce();
    expect(resolveSpy.mock.calls[0][1].jobUrl).toBe(eligibleUrl);
    expect(resolved).toEqual([eligibleApplication]);
    expect(renderIngestFilterReportCsv(report)).toBe(
      'section,awl_id,job_url\r\n' +
      `clearance,,${clearanceUrl}\r\n` +
      `excluded_company,AWL-1,${excludedUrl}\r\n` +
      `latest_employer,AWL-1,${excludedUrl}\r\n`
    );
  });
});
