import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import JobQueueView from '../dashboard/JobQueueView.js';

// Custom matcher for testing in static markup environment
expect.extend({
  toBeInTheDocument(received: any) {
    const pass = received !== null && received !== undefined;
    return {
      pass,
      message: () => `expected element ${pass ? 'not ' : ''}to be in document`,
    };
  },
});

let currentHtml = '';

function render(ui: React.ReactElement) {
  currentHtml = renderToStaticMarkup(ui);
  return {
    html: currentHtml,
  };
}

const screen = {
  getByText(matcher: RegExp | string) {
    const plainText = currentHtml.replace(/<[^>]+>/g, ' ');
    const matches = typeof matcher === 'string' ? plainText.includes(matcher) : matcher.test(plainText);
    if (!matches) {
      throw new Error(`Unable to find an element with text matching: ${matcher}\nRendered HTML:\n${currentHtml}`);
    }
    return {
      textContent: plainText,
    };
  },
  getByTestId(testId: string) {
    const regex = new RegExp(`<([a-zA-Z0-9]+)[^>]*data-testid=["']${testId}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i');
    const match = currentHtml.match(regex);
    if (!match) {
      throw new Error(`Unable to find element with data-testid: ${testId}\nRendered HTML:\n${currentHtml}`);
    }
    const innerText = match[2].replace(/<[^>]+>/g, '').trim();
    return {
      textContent: innerText,
      rawHtml: match[0],
    };
  },
  queryByTestId(testId: string) {
    const regex = new RegExp(`<([a-zA-Z0-9]+)[^>]*data-testid=["']${testId}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i');
    const match = currentHtml.match(regex);
    if (!match) {
      return null;
    }
    const innerText = match[2].replace(/<[^>]+>/g, '').trim();
    return {
      textContent: innerText,
      rawHtml: match[0],
    };
  },
};

const baseProps = { selectedJob: null, onJobSelect: () => {}, apiBaseUrl: '' };

describe('JobQueueView Failure Badge', () => {
  it('shows failure badge for FAILED job with error_message', () => {
    const jobs = [
      {
        id: '1',
        rawUrl: 'x',
        companyName: 'Acme',
        jobTitle: 'SWE',
        status: 'FAILED',
        error_message: 'Missing required field: resume',
        resolved_fields: [],
      },
    ];
    render(<JobQueueView {...(baseProps as any)} jobs={jobs as any} />);
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
    expect(screen.getByText(/Missing required field/i)).toBeInTheDocument();
  });

  it('truncates error_message longer than 60 chars', () => {
    const long = 'A'.repeat(150);
    const jobs = [
      {
        id: '1',
        rawUrl: 'x',
        companyName: 'Acme',
        jobTitle: 'SWE',
        status: 'FAILED',
        error_message: long,
        resolved_fields: [],
      },
    ];
    render(<JobQueueView {...(baseProps as any)} jobs={jobs as any} />);
    const badge = screen.getByTestId('failure-badge');
    expect(badge.textContent!.length).toBeLessThan(90);
  });

  it('shows no failure badge for READY_FOR_REVIEW', () => {
    const jobs = [
      {
        id: '1',
        rawUrl: 'x',
        companyName: 'Acme',
        jobTitle: 'SWE',
        status: 'READY_FOR_REVIEW',
        error_message: null,
        resolved_fields: [],
      },
    ];
    render(<JobQueueView {...(baseProps as any)} jobs={jobs as any} />);
    expect(screen.queryByTestId('failure-badge')).toBeNull();
  });
});
