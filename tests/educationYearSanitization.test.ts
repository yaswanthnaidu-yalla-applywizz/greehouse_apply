import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyEducationFieldFallbacks } from '../src/submitter/formFiller.js';

describe('Education Year Sanitization', () => {
  it('normalizes ISO date string to 4-digit year for start and end date fields', () => {
    const fields = [
      { fieldId: 'school--0', name: 'school--0', label: 'School', value: 'Stanford University' },
      { fieldId: 'degree--0', name: 'degree--0', label: 'Degree', value: "Master's Degree" },
      { fieldId: 'discipline--0', name: 'discipline--0', label: 'Discipline', value: 'Computer Science' },
      { fieldId: 'start-year--0', name: 'start-year--0', label: 'Start date year', value: '2026-02-24' },
      { fieldId: 'end-year--0', name: 'end-year--0', label: 'End date year', value: '2026-03-26' },
    ];

    const result = applyEducationFieldFallbacks(fields, true);

    const startYear = result.find(f => f.fieldId === 'start-year--0')?.value;
    const endYear = result.find(f => f.fieldId === 'end-year--0')?.value;

    assert.equal(startYear, '2026');
    assert.equal(endYear, '2026');
  });

  it('preserves valid 4-digit years intact', () => {
    const fields = [
      { fieldId: 'start-year--0', name: 'start-year--0', label: 'Start date year', value: '2019' },
      { fieldId: 'end-year--0', name: 'end-year--0', label: 'End date year', value: '2023' },
    ];

    const result = applyEducationFieldFallbacks(fields, true);

    assert.equal(result.find(f => f.fieldId === 'start-year--0')?.value, '2019');
    assert.equal(result.find(f => f.fieldId === 'end-year--0')?.value, '2023');
  });

  it('extracts year even if format is MM/YYYY or DD-MM-YYYY', () => {
    const fields = [
      { fieldId: 'start-year--0', name: 'start-year--0', label: 'Start date year', value: '05/2018' },
      { fieldId: 'end-year--0', name: 'end-year--0', label: 'End date year', value: '15-06-2022' },
    ];

    const result = applyEducationFieldFallbacks(fields, true);

    assert.equal(result.find(f => f.fieldId === 'start-year--0')?.value, '2018');
    assert.equal(result.find(f => f.fieldId === 'end-year--0')?.value, '2022');
  });
});
