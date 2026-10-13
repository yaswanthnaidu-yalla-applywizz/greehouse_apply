import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildQuestionRelevantEvidence } from '../src/resolver/candidateEvidence.js';

describe('STAR Grounding with Candidate Evidence & QA Bank', () => {
  it('includes past QA bank entries when available for behavioral questions', () => {
    const profile = {
      clientName: 'Jane Doe',
      qaBankAnswers: [
        { question_label: 'Tell us about a time you optimized database queries', value: 'Reduced PostgreSQL query latency by 45% using composite indexes.' }
      ]
    };
    const evidence = buildQuestionRelevantEvidence(
      { fieldId: 'q', name: 'q', label: 'Have you worked with database optimization before?', type: 'textarea' },
      profile,
      'PostgreSQL database administrator with 5 years experience.'
    );
    assert.match(evidence, /Reduced PostgreSQL query latency by 45%/i);
  });
});
