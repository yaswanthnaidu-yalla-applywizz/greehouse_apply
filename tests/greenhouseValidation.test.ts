import { describe, expect, it, vi } from 'vitest';
import { validateGreenhouseSubmission } from '../src/submitter/greenhouseValidation.js';

function summary(overrides: Partial<any> = {}) {
  return {
    applicationId: 'app',
    jobUrl: 'https://job-boards.greenhouse.io/example/jobs/1',
    totalFields: 1,
    filledFields: 1,
    failedFields: 0,
    results: [{
      fieldId: 'authorization',
      name: 'authorization',
      type: 'select',
      label: 'Authorization',
      valuePopulated: 'Yes',
      isRequired: true,
      success: true,
      domCommitted: true,
      ...overrides,
    }],
  } as any;
}

const application = { id: 'app', applywizz_id: 'AWL-TEST', resolved_fields: [] } as any;

describe('Greenhouse submission gate', () => {
  it('accepts a required field committed to the DOM', async () => {
    const page = { evaluate: vi.fn().mockResolvedValue([]) } as any;
    await expect(validateGreenhouseSubmission(page, application, summary())).resolves.toEqual({
      ok: true,
      committedRequiredFieldIds: ['authorization'],
    });
  });

  it('rejects a non-empty answer that was not committed to the DOM', async () => {
    const page = { evaluate: vi.fn().mockResolvedValue([]) } as any;
    const result = await validateGreenhouseSubmission(page, application, summary({ domCommitted: false }));
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.failure.fields[0].label).toBe('Authorization');
  });

  it('rejects browser-invalid controls even when filler accounting looks complete', async () => {
    const page = {
      evaluate: vi.fn().mockResolvedValue([{ fieldId: 'phone', label: 'Phone', message: 'Phone number is too long' }]),
    } as any;
    const result = await validateGreenhouseSubmission(page, application, summary());
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.failure.fields[0].message).toMatch(/Phone number is too long/);
  });
});
