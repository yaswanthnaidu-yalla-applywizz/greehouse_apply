import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FormRenderer } from '../dashboard/FormRenderer.js';

describe('FormRenderer empty states (Issue 2.4 fix)', () => {
  it('renders Queue Complete state when candidate has 0 queue jobs', () => {
    const html = renderToStaticMarkup(
      <FormRenderer
        application={null}
        totalQueueJobs={0}
        hasSelectedJob={false}
      />
    );
    expect(html).toContain('data-testid="queue-complete-state"');
    expect(html).toContain('Queue Complete');
    expect(html).toContain('All assigned applications for this candidate have been processed');
  });

  it('renders Resolution Pending state when job is selected but application is not yet resolved', () => {
    const html = renderToStaticMarkup(
      <FormRenderer
        application={null}
        totalQueueJobs={3}
        hasSelectedJob={true}
      />
    );
    expect(html).toContain('data-testid="resolution-pending-state"');
    expect(html).toContain('Resolution in Progress');
    expect(html).toContain('Field answers are currently being generated for this job');
  });

  it('renders Select an Application state when jobs exist but none is selected', () => {
    const html = renderToStaticMarkup(
      <FormRenderer
        application={null}
        totalQueueJobs={3}
        hasSelectedJob={false}
      />
    );
    expect(html).toContain('data-testid="no-job-selected-state"');
    expect(html).toContain('Select an Application');
    expect(html).toContain('Choose a job card from the queue above to review and submit');
  });
});
