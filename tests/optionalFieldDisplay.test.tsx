import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditableFormField } from '../dashboard/components/EditableFormField.js';
import type { ResolvedField } from '../dashboard/types.js';

describe('optional field display', () => {
  const field: ResolvedField = { fieldId: 'q', name: 'q', label: 'Question', type: 'text', value: '', source: 'unresolved', isRequired: false, confidence: 0 };

  it('shows an editable grey unrequired state for an unanswered optional field', () => {
    const html = renderToStaticMarkup(<EditableFormField field={field} applicationId="app" />);
    expect(html).toContain('Unrequired');
    expect(html).toContain('Click to edit');
    expect(html).not.toContain('#ff453a');
  });

  it('keeps the source for an answered optional field and the warning for a required one', () => {
    const answered = renderToStaticMarkup(<EditableFormField field={{ ...field, value: 'Yes', source: 'ai' }} applicationId="app" />);
    expect(answered).toContain('ai');
    expect(answered).not.toContain('Unrequired');
    const required = renderToStaticMarkup(<EditableFormField field={{ ...field, isRequired: true }} applicationId="app" />);
    expect(required).toContain('unresolved');
    expect(required).toContain('#ff453a');
  });
});
