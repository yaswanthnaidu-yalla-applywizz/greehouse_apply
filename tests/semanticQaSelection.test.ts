import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCompatibleQaMatch } from '../src/resolver/semanticSearch.js';

test('semantic QA selection skips an incompatible top row', () => {
  const rows = [
    { question_label: 'Company email', value: 'person@example.com', similarity: 0.96 },
    { question_label: 'Current employer', value: 'Acme Corp', similarity: 0.91 },
  ];
  const result = selectCompatibleQaMatch(rows, { family: 'employer_history' }, undefined, 'text', 0.82);
  assert.equal(result?.value, 'Acme Corp');
});

test('semantic QA selection rejects rows without provenance', () => {
  assert.equal(selectCompatibleQaMatch([{ value: 'Acme Corp', similarity: 0.99 }], { family: 'employer_history' }, undefined, 'text', 0.82), null);
});
