import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { alignAndFilterCandidateSegmentJobs } from '../src/orchestrator/pipeline.js';
import type { CandidateSegment } from '../src/types/index.js';

describe('Pipeline Shortlink Alignment & Job Filtering (TDD)', () => {
  it('resolves grnh.se shortlinks so candidate segment jobs match allowed canonical URLs and are not dropped', async () => {
    const rawShortlink = 'https://grnh.se/abc1234';
    const canonicalTarget = 'https://job-boards.greenhouse.io/targetcompany/jobs/999888';

    const segment: CandidateSegment = {
      applywizzId: 'AWL-101',
      clientName: 'Alice',
      syncedAt: new Date().toISOString(),
      totalJobs: 1,
      jobs: [
        {
          rawUrl: rawShortlink,
          canonicalUrl: rawShortlink,
          taskId: 'task-uuid-1',
          score: 88,
        },
      ],
    };

    // Phase A scanned and expanded the shortlink to canonicalTarget
    const allowedJobUrls = new Set<string>([canonicalTarget]);

    const mockResolveShortlink = async (url: string) => {
      if (url === rawShortlink) return canonicalTarget;
      return url;
    };

    await alignAndFilterCandidateSegmentJobs([segment], allowedJobUrls, mockResolveShortlink);

    // Assert that the job was NOT dropped
    assert.equal(segment.jobs.length, 1, 'Job must be retained, not dropped');
    assert.equal(segment.totalJobs, 1, 'totalJobs must be updated to 1');
    assert.equal(segment.jobs[0].canonicalUrl, canonicalTarget, 'canonicalUrl must be updated to target');
    assert.equal(segment.jobs[0].rawUrl, rawShortlink, 'rawUrl must preserve original link');
    assert.equal(segment.jobs[0].taskId, 'task-uuid-1', 'taskId must be preserved');
  });

  it('filters out jobs that are not in allowedJobUrls even after resolution', async () => {
    const rawShortlink = 'https://grnh.se/other567';
    const canonicalTarget = 'https://job-boards.greenhouse.io/othercompany/jobs/555444';

    const segment: CandidateSegment = {
      applywizzId: 'AWL-102',
      clientName: 'Bob',
      syncedAt: new Date().toISOString(),
      totalJobs: 1,
      jobs: [
        {
          rawUrl: rawShortlink,
          canonicalUrl: rawShortlink,
          taskId: 'task-uuid-2',
        },
      ],
    };

    // allowedJobUrls does NOT contain canonicalTarget (e.g. outside --limit)
    const allowedJobUrls = new Set<string>(['https://job-boards.greenhouse.io/different/jobs/111']);

    const mockResolveShortlink = async (url: string) => {
      if (url === rawShortlink) return canonicalTarget;
      return url;
    };

    await alignAndFilterCandidateSegmentJobs([segment], allowedJobUrls, mockResolveShortlink);

    assert.equal(segment.jobs.length, 0, 'Job outside allowed URLs must be filtered out');
    assert.equal(segment.totalJobs, 0, 'totalJobs must be updated to 0');
  });

  it('retains jobs that already have canonical URLs without needing shortlink resolution', async () => {
    const canonicalUrl = 'https://job-boards.greenhouse.io/directcompany/jobs/777888';

    const segment: CandidateSegment = {
      applywizzId: 'AWL-103',
      clientName: 'Charlie',
      syncedAt: new Date().toISOString(),
      totalJobs: 1,
      jobs: [
        {
          rawUrl: canonicalUrl,
          canonicalUrl: canonicalUrl,
          taskId: 'task-uuid-3',
        },
      ],
    };

    const allowedJobUrls = new Set<string>([canonicalUrl]);
    let resolveCalled = false;
    const mockResolveShortlink = async (url: string) => {
      resolveCalled = true;
      return url;
    };

    await alignAndFilterCandidateSegmentJobs([segment], allowedJobUrls, mockResolveShortlink);

    assert.equal(resolveCalled, false, 'resolveShortlink must not be called for non-shortlink URLs');
    assert.equal(segment.jobs.length, 1);
    assert.equal(segment.totalJobs, 1);
    assert.equal(segment.jobs[0].canonicalUrl, canonicalUrl);
  });
});
