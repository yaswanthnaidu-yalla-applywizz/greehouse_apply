import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyFieldIntent, isAnswerableField, isEvidenceCompatible } from '../src/resolver/fieldIntent.js';
import type { ResolutionExecution } from '../src/resolver/resolutionMode.js';

test('choice semantics classify SMS consent before a generic phone label', () => {
  assert.equal(classifyFieldIntent({ fieldId: 'sms', name: 'phone', type: 'radio', label: 'Phone Number', isRequired: true, options: ['Yes, text me', 'No, do not text me'] }).family, 'agreement_consent');
});

test('telephone inputs remain contact fields and workplace facts do not answer residence', () => {
  assert.equal(classifyFieldIntent({ fieldId: 'phone', name: 'phone', type: 'text', label: 'Phone Number', isRequired: true, metadata: { inputType: 'tel' } }).family, 'contact_profile');
  const workplace = classifyFieldIntent({ fieldId: 'work-location', name: 'work_location', type: 'select', label: 'Office location preference', isRequired: true });
  assert.equal(workplace.family, 'workplace_preference');
  assert.equal(isEvidenceCompatible(workplace, { kind: 'job_posting_location' }), true);
  const residence = classifyFieldIntent({ fieldId: 'residence', name: 'residence', type: 'text', label: 'Current city of residence', isRequired: true });
  assert.equal(residence.family, 'residence');
  assert.equal(isEvidenceCompatible(residence, { kind: 'job_posting_location' }), false);
});

test('uncertain singleton controls remain answerable without positive widget evidence', () => {
  const field = { fieldId: 'consent', name: 'consent', type: 'checkbox' as const, label: 'Consent', isRequired: true };
  assert.equal(isAnswerableField(field), true);
  assert.equal(isAnswerableField({ ...field, classification: 'system_widget' }), false);
});

test('shadow mode execution forbids Tier 5 and write capabilities', () => {
  const shadowExec: ResolutionExecution = { kind: 'shadow', allowTier5: false, allowWrites: false };
  assert.equal(shadowExec.kind, 'shadow');
  assert.equal(shadowExec.allowTier5, false);
  assert.equal(shadowExec.allowWrites, false);
});

