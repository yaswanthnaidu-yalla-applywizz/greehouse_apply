import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { persistApprovedAiAnswersToQaBank } from '../src/db/qaBankPersistence.js';
import { getAnswer } from '../src/db/qaBank.js';
import { generateFingerprint } from '../src/resolver/fingerprint.js';
import type { ResolvedField } from '../src/types/index.js';

describe('persistApprovedAiAnswersToQaBank', () => {
  it('persists AI-resolved and manual fields to QA bank with manual/approved source', async () => {
    const candidateId = `TEST_CANDIDATE_${Date.now()}`;
    const fields: ResolvedField[] = [
      {
        fieldId: 'q1',
        name: 'why_us',
        type: 'textarea',
        label: 'Why work here?',
        value: 'Passionate about engineering',
        source: 'ai',
        resolvedByTier: 5,
        confidence: 0.9,
      },
      {
        fieldId: 'q2',
        name: 'salary_exp',
        type: 'text',
        label: 'Desired salary',
        value: '120,000',
        source: 'manual',
        isEdited: true,
        confidence: 1.0,
      },
      {
        fieldId: 'q3',
        name: 'phone',
        type: 'text',
        label: 'Phone number',
        value: '555-0199',
        source: 'resume_parse',
        resolvedByTier: 2,
        confidence: 1.0,
      },
    ];

    await persistApprovedAiAnswersToQaBank(candidateId, fields);

    // AI field should now be in QA bank
    const fp1 = generateFingerprint('Why work here?', 'textarea');
    const qa1 = await getAnswer(candidateId, fp1);
    assert.ok(qa1, 'AI-resolved answer should be written to QA bank');
    assert.equal(qa1?.value, 'Passionate about engineering');
    assert.equal(qa1?.source, 'manual'); // Approved by operator

    // Manual field should also be in QA bank
    const fp2 = generateFingerprint('Desired salary', 'text');
    const qa2 = await getAnswer(candidateId, fp2);
    assert.ok(qa2, 'Manual answer should be written to QA bank');
    assert.equal(qa2?.value, '120,000');
    assert.equal(qa2?.source, 'manual');

    // Resume parse field should NOT be overwritten into QA bank
    const fp3 = generateFingerprint('Phone number', 'text');
    const qa3 = await getAnswer(candidateId, fp3);
    assert.equal(qa3, null, 'Verified resume answers do not need QA bank duplication');
  });
});
