import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSinglePrompt } from '../src/resolver/llmSynthesizer.js';

describe('STAR Prompt Directives in LLMSynthesizer', () => {
  const profile = {
    clientName: 'Alex Mercer',
    applywizzId: 'AWL-12345',
    workAuthorization: 'US Citizen',
    requiresSponsorship: false,
    location: 'Austin, TX',
  } as any;

  it('injects STAR instructions into single prompt for behavioral questions', () => {
    const prompt = buildSinglePrompt(
      { fieldId: 'q1', name: 'q1', type: 'textarea', label: 'Have you worked with Kubernetes in production?' },
      profile,
      'Senior DevOps Engineer at Acme Corp. Deployed Kubernetes clusters...',
      { title: 'DevOps Engineer', company: 'Acme Cloud' }
    );
    assert.match(prompt, /STAR methodology/i);
    assert.match(prompt, /50 to 80 words/i);
    assert.match(prompt, /Situation, Task, Action, and Result/i);
    assert.match(prompt, /first-person/i);
  });

  it('injects STAR instructions into single prompt for company interest questions', () => {
    const prompt = buildSinglePrompt(
      { fieldId: 'q2', name: 'q2', type: 'textarea', label: 'Why choose our company?' },
      profile,
      'Passionate about scalable cloud architectures...',
      { title: 'Backend Engineer', company: 'Datadog' }
    );
    assert.match(prompt, /STAR methodology/i);
    assert.match(prompt, /Datadog/i);
  });

  it('does NOT inject STAR instructions for simple factual text fields', () => {
    const prompt = buildSinglePrompt(
      { fieldId: 'url', name: 'url', type: 'text', label: 'Personal Website / Portfolio URL' },
      profile,
      'Resume text',
      { title: 'Engineer', company: 'Acme' }
    );
    assert.doesNotMatch(prompt, /STAR methodology/i);
  });

  it('annotates behavioral questions in batch prompt with STAR format guidance', async () => {
    const { buildBatchPrompt } = await import('../src/resolver/llmSynthesizer.js');
    const batchPrompt = buildBatchPrompt(
      [
        { label: 'Describe a complex migration you executed', type: 'textarea' },
        { label: 'Website URL', type: 'text' },
      ],
      'Senior Infrastructure Engineer job description',
      profile
    );
    assert.match(batchPrompt, /STAR format 50-80 words/i);
    assert.match(batchPrompt, /Situation-Task-Action-Result/i);
  });
});
