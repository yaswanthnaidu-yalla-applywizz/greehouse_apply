import assert from 'node:assert';
import { applyEducationFieldFallbacks } from '../src/submitter/formFiller';

const fields = [
  { fieldId: 'education_discipline', name: 'discipline--0', label: 'Discipline', value: '' },
  { fieldId: 'education_start_year', name: 'start-year--0', label: 'Start Year', value: '2026-08-01' },
  { fieldId: 'education_end_year', name: 'end-year--0', label: 'End Year', value: '2027-05-01' },
  { fieldId: 'education_school', name: 'school--0', label: 'School', value: 'San Jose State University' }
];

const filled = applyEducationFieldFallbacks(fields, true);

assert.strictEqual(filled.find(f => f.name === 'discipline--0')?.value, 'Computer Science');
assert.strictEqual(filled.find(f => f.name === 'start-year--0')?.value, '2018');
assert.strictEqual(filled.find(f => f.name === 'end-year--0')?.value, '2022');
console.log('✅ All education fallback assertions passed!');
