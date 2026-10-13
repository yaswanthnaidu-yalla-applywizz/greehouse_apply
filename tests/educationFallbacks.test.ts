import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyEducationFieldFallbacks } from '../src/submitter/formFiller.js';

describe('Education Field Fallbacks', () => {
  it('supplies defaults for degree, discipline, start and end dates when education section is required on DOM', () => {
    const fields = [
      { fieldId: 'school--0', name: 'school--0', label: 'School', value: 'Stanford University' },
      { fieldId: 'degree--0', name: 'degree--0', label: 'Degree', value: '' },
      { fieldId: 'discipline--0', name: 'discipline--0', label: 'Discipline', value: '' },
      { fieldId: 'start_date--0', name: 'start_date--0', label: 'Start Date', value: '' },
      { fieldId: 'end_date--0', name: 'end_date--0', label: 'End Date', value: '' },
    ];

    const result = applyEducationFieldFallbacks(fields, true);

    const degree = result.find(f => f.fieldId === 'degree--0')?.value;
    const discipline = result.find(f => f.fieldId === 'discipline--0')?.value;
    const startDate = result.find(f => f.fieldId === 'start_date--0')?.value;
    const endDate = result.find(f => f.fieldId === 'end_date--0')?.value;

    assert.equal(degree, "Bachelor's Degree");
    assert.equal(discipline, 'Computer Science');
    assert.equal(startDate, '2018');
    assert.equal(endDate, '2022');
  });

  it('leaves fields unchanged when education section is not required', () => {
    const fields = [
      { fieldId: 'degree--0', name: 'degree--0', label: 'Degree', value: '' },
      { fieldId: 'discipline--0', name: 'discipline--0', label: 'Discipline', value: '' },
    ];
    const result = applyEducationFieldFallbacks(fields, false);
    assert.equal(result[0].value, '');
    assert.equal(result[1].value, '');
  });
});
