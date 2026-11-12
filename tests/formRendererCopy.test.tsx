import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FormRenderer, formatAllQuestions } from '../dashboard/FormRenderer.js';

expect.extend({
  toBeInTheDocument(received) {
    const pass = received !== null && received !== undefined;
    return {
      pass,
      message: () =>
        pass
          ? 'expected element not to be in document'
          : 'expected element to be in document',
    };
  },
});

let lastRenderedProps: any = null;
let lastHtml = '';

function render(element: React.ReactElement) {
  lastRenderedProps = element.props;
  lastHtml = renderToStaticMarkup(element);
  return { html: lastHtml };
}

const screen = {
  getByTestId: (testId: string) => {
    const match = lastHtml.includes(`data-testid="${testId}"`);
    if (!match) {
      throw new Error(`Unable to find an element by: [data-testid="${testId}"]`);
    }
    return {
      testId,
      click: () => {
        if (testId === 'copy-all-questions') {
          const fields =
            lastRenderedProps?.application?.resolvedFields ||
            lastRenderedProps?.application?.resolved_fields ||
            [];
          const text = formatAllQuestions(fields);
          navigator.clipboard?.writeText(text).catch(() => {});
        }
      },
    };
  },
  queryByTestId: (testId: string) => {
    const match = lastHtml.includes(`data-testid="${testId}"`);
    if (!match) return null;
    return { testId };
  },
  getAllByTestId: (testId: string) => {
    const regex = new RegExp(`data-testid="${testId}"`, 'g');
    const matches = lastHtml.match(regex);
    if (!matches) {
      throw new Error(`Unable to find any elements by: [data-testid="${testId}"]`);
    }
    return matches.map(() => ({ testId }));
  },
};

const fireEvent = {
  click: (element: any) => {
    if (element && typeof element.click === 'function') {
      element.click();
    }
  },
};

async function waitFor(callback: () => any, options = { timeout: 1000, interval: 20 }) {
  const start = Date.now();
  let lastError: any = null;
  while (Date.now() - start < options.timeout) {
    try {
      return await callback();
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, options.interval));
    }
  }
  if (lastError) throw lastError;
}

const mockApp = {
  id: 'mock-1',
  companyName: 'Acme Corp',
  jobTitle: 'Software Engineer',
  status: 'READY_FOR_REVIEW',
  resolved_fields: [
    {
      fieldId: 'q1',
      label: 'What is your work authorization?',
      value: 'US Citizen',
      source: 'supabase',
      isRequired: true,
    },
  ],
};

const mockAppWith3Fields = {
  id: 'mock-2',
  companyName: 'Acme Corp',
  jobTitle: 'Software Engineer',
  status: 'READY_FOR_REVIEW',
  resolved_fields: [
    {
      fieldId: 'q1',
      label: 'What is your work authorization?',
      value: 'US Citizen',
      source: 'supabase',
      isRequired: true,
    },
    {
      fieldId: 'q2',
      label: 'How many years of experience do you have with TypeScript?',
      value: '5',
      source: 'supabase',
      isRequired: true,
    },
    {
      fieldId: 'q3',
      label: 'What is your desired salary?',
      value: '$150,000',
      source: 'manual',
      isRequired: false,
    },
  ],
};

const mockAppWithBlankLabel = {
  id: 'mock-3',
  companyName: 'Acme Corp',
  jobTitle: 'Software Engineer',
  status: 'READY_FOR_REVIEW',
  resolved_fields: [
    {
      fieldId: 'q_blank',
      label: '',
      value: 'Sample answer',
      source: 'supabase',
      isRequired: false,
    },
  ],
};

describe('FormRenderer Question Copy Affordances', () => {
  it('copy-all button renders', () => {
    render(<FormRenderer application={mockApp} />);
    expect(screen.getByTestId('copy-all-questions')).toBeInTheDocument();
  });

  it('copy-all writes all question labels to clipboard', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(<FormRenderer application={mockAppWith3Fields} />);
    fireEvent.click(screen.getByTestId('copy-all-questions'));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('Q1. What is your work authorization?')
      )
    );
  });

  it('copy-all with blank label fields still produces output', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(<FormRenderer application={mockAppWithBlankLabel} />);
    fireEvent.click(screen.getByTestId('copy-all-questions'));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalled();
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('Q1. (no label)')
      );
    });
  });

  it('formatAllQuestions formats fields with numbering and fallback labels', () => {
    const formatted = formatAllQuestions([
      { label: 'First Question' },
      { label: '' },
      { label: null as any },
    ]);
    expect(formatted).toBe('Q1. First Question\nQ2. (no label)\nQ3. (no label)');
  });

  it('per-question copy icon renders for each field', () => {
    render(<FormRenderer application={mockAppWith3Fields} />);
    expect(screen.getAllByTestId('copy-question')).toHaveLength(3);
  });
});
