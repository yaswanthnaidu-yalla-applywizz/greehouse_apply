import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isBehavioralOrMotivationalQuestion } from '../src/resolver/starClassifier.js';
import { buildSinglePrompt, buildBatchPrompt } from '../src/resolver/llmSynthesizer.js';

describe('STAR Synthesis End-to-End Regression Verification', () => {
  const profile = {
    clientName: 'Sarah Connor',
    applywizzId: 'AWL-99887',
    workAuthorization: 'US Citizen',
    requiresSponsorship: false,
    location: 'Los Angeles, CA',
  } as any;

  it('correctly distinguishes open-ended behavioral questions from choice/boolean fields', () => {
    // Open-ended
    assert.strictEqual(
      isBehavioralOrMotivationalQuestion({ label: 'Have you worked with distributed caching before?', type: 'textarea' }),
      true
    );
    assert.strictEqual(
      isBehavioralOrMotivationalQuestion({ label: 'Why choose our company for your next role?', type: 'text' }),
      true
    );

    // Multi-choice with "experience" must NOT trigger STAR prose
    assert.strictEqual(
      isBehavioralOrMotivationalQuestion({
        label: 'Do you have experience with Redis?',
        type: 'select',
        options: ['Yes', 'No'],
      }),
      false
    );
    assert.strictEqual(
      isBehavioralOrMotivationalQuestion({
        label: 'Years of Kubernetes experience',
        type: 'radio',
        options: ['0-1 years', '2-4 years', '5+ years'],
      }),
      false
    );
  });

  it('generates prompt with STAR methodology, 50-80 words, and first-person tone constraints', () => {
    const prompt = buildSinglePrompt(
      {
        fieldId: 'behavioral_1',
        name: 'behavioral_1',
        type: 'textarea',
        label: 'Tell us about a time you resolved a major production incident.',
      },
      profile,
      'Lead Site Reliability Engineer. Restored Redis cluster uptime from 95% to 99.99%...',
      { title: 'Senior SRE', company: 'Stripe' }
    );

    assert.match(prompt, /STAR methodology/i);
    assert.match(prompt, /50 to 80 words/i);
    assert.match(prompt, /first-person/i);
    assert.match(prompt, /Stripe/i);
  });

  it('includes STAR directives in batch prompt for multiple questions', () => {
    const batchPrompt = buildBatchPrompt(
      [
        { label: 'Why do you want to join our engineering team?', type: 'textarea' },
        { label: 'Do you require sponsorship?', type: 'radio', options: ['Yes', 'No'] },
      ],
      'Stripe Infrastructure Engineer job posting',
      profile
    );

    assert.match(batchPrompt, /STAR format 50-80 words/i);
    assert.match(batchPrompt, /Situation-Task-Action-Result/i);
  });
});
