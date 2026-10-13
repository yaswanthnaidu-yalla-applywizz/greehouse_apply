import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isBehavioralOrMotivationalQuestion } from '../src/resolver/starClassifier.js';

describe('STAR Question Classifier', () => {
  it('returns true for open-ended behavioral questions', () => {
    assert.strictEqual(isBehavioralOrMotivationalQuestion({ label: 'Have you worked with Kubernetes in production?', type: 'textarea' }), true);
    assert.strictEqual(isBehavioralOrMotivationalQuestion({ label: 'Describe a challenging bug you fixed recently.', type: 'text' }), true);
    assert.strictEqual(isBehavioralOrMotivationalQuestion({ label: 'Tell us about a time you led a team initiative.', type: 'textarea' }), true);
  });

  it('returns true for company motivation and interest questions', () => {
    assert.strictEqual(isBehavioralOrMotivationalQuestion({ label: 'Why do you want to work at our company?', type: 'textarea' }), true);
    assert.strictEqual(isBehavioralOrMotivationalQuestion({ label: 'Why are you interested in this role?', type: 'text' }), true);
    assert.strictEqual(isBehavioralOrMotivationalQuestion({ label: 'What makes you a good fit for Stripe?', type: 'textarea' }), true);
  });

  it('returns false for choice/select/radio/checkbox questions even with behavioral keywords', () => {
    assert.strictEqual(isBehavioralOrMotivationalQuestion({ label: 'Have you worked with React before?', type: 'select', options: ['Yes', 'No'] }), false);
    assert.strictEqual(isBehavioralOrMotivationalQuestion({ label: 'Do you have 5+ years experience?', type: 'radio', options: ['Yes', 'No'] }), false);
  });

  it('returns false for standard factual fields (URLs, names, phone, salary, EEO)', () => {
    assert.strictEqual(isBehavioralOrMotivationalQuestion({ label: 'LinkedIn Profile URL', type: 'text' }), false);
    assert.strictEqual(isBehavioralOrMotivationalQuestion({ label: 'Desired Salary', type: 'text' }), false);
    assert.strictEqual(isBehavioralOrMotivationalQuestion({ label: 'Please identify your race', type: 'select', options: ['Asian', 'White'] }), false);
  });
});
