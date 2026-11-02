import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEducationFieldFallbacks } from '../src/submitter/formFiller.js';

test('applyEducationFieldFallbacks populates start date month and end date month when blank', () => {
  const fields = [
    { fieldId: 'education_attributes--start_date_month', label: 'Start date month', value: '', isRequired: true },
    { fieldId: 'education_attributes--end_date_month', label: 'End date month', value: '', isRequired: true },
    { fieldId: 'education_attributes--discipline', label: 'Discipline', value: '', isRequired: true },
  ];
  const filled = applyEducationFieldFallbacks(fields as any, true);
  assert.equal(filled[0].value, '08');
  assert.equal(filled[1].value, '05');
  assert.equal(filled[2].value, 'Computer Science');
});

test('applyEducationFieldFallbacks preserves existing month values', () => {
  const fields = [
    { fieldId: 'education_attributes--start_date_month', label: 'Start date month', value: '09', isRequired: true },
    { fieldId: 'education_attributes--end_date_month', label: 'End date month', value: 'May', isRequired: true },
  ];
  const filled = applyEducationFieldFallbacks(fields as any, true);
  assert.equal(filled[0].value, '09');
  assert.equal(filled[1].value, 'May');
});
