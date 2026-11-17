import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCorporatePolicy, CORPORATE_POLICY_PROMPT_GUIDELINES } from '../src/resolver/corporatePolicies.js';
import { buildSinglePrompt, buildBatchPrompt } from '../src/resolver/llmSynthesizer.js';
import type { ScannedField } from '../src/types/index.js';
import type { ProfileRow } from '../src/db/profiles.js';

test('CORPORATE_POLICY_PROMPT_GUIDELINES instructs LLM to answer as human and never identify as AI or bot', () => {
  const lower = CORPORATE_POLICY_PROMPT_GUIDELINES.toLowerCase();
  assert.ok(lower.includes('never identify as an ai, bot'), 'Must instruct never to identify as AI/bot');
  assert.ok(lower.includes('i am a human'), 'Must specify human applicant choice');
});

test('buildSinglePrompt and buildBatchPrompt include anti-bot and human candidate instructions', () => {
  const field: ScannedField = {
    fieldId: 'trap_select',
    name: 'trap_select',
    type: 'select',
    label: 'Which describes you?',
    options: ['I am an AI, bot, or automated program.', 'I am a human.'],
  };
  const profile: any = {
    applywizzId: 'AWL-1',
    clientName: 'Test Candidate',
  };
  const singlePrompt = buildSinglePrompt(field, profile, '', { company: 'TestCorp', title: 'Engineer' });
  assert.ok(singlePrompt.includes('anti-bot screening questions'), 'Single prompt must include anti-bot screening instruction');
  assert.ok(singlePrompt.includes('Never select an AI, bot'), 'Single prompt must forbid selecting AI/bot');

  const batchPrompt = buildBatchPrompt([{ ...field, candidateEvidence: '' }], 'Job description', profile);
  assert.ok(batchPrompt.includes('Never identify as an AI, bot, or automated program'), 'Batch prompt must instruct never identify as AI/bot');
});

test('matchCorporatePolicy selects I am a human on anti-bot screening trap', () => {
  const field: ScannedField = {
    fieldId: 'anti_bot_trap',
    name: 'anti_bot_trap',
    type: 'select',
    label: 'Which of the following best describes you?',
    options: ['I am an AI, bot, or automated program. ', 'I am a human. '],
    isRequired: true,
  };
  const val = matchCorporatePolicy(field);
  assert.equal(val, 'I am a human. ');
});

test('matchCorporatePolicy selects not a U.S. person on EAR questions when requires_sponsorship is true', () => {
  const field: ScannedField = {
    fieldId: 'ear_compliance',
    name: 'ear_compliance',
    type: 'select',
    label: 'Are you a U.S. Person as defined by Export Administration Regulations (EAR)?',
    options: ['I am a U.S. Person', 'I am not a U.S. Person'],
    isRequired: true,
  };
  const profile: ProfileRow = {
    applywizz_id: 'AWL-SPONSOR-1',
    client_name: 'Test Candidate',
    requires_sponsorship: true,
    work_authorization: 'F1',
  };
  const val = matchCorporatePolicy(field, profile);
  assert.equal(val, 'I am not a U.S. Person');
});
