/**
 * @fileoverview Integration Test for Phase V2-3: Inline Review & Manual Edit Endpoint.
 */

import express from 'express';
import { createServer } from '../src/server/index.js';
import { upsertApplication } from '../src/db/applications.js';
import { getAnswer } from '../src/db/qaBank.js';
import { resolveTier1 } from '../src/resolver/tier1Supabase.js';
import { generateFingerprint } from '../src/resolver/fingerprint.js';
import type { ScannedField } from '../src/types/index.js';

async function runPatchTests() {
  console.log('🧪 Starting Phase V2-3 Inline Edit & PATCH Tests...\n');

  let passed = 0;
  let total = 0;

  function assert(condition: boolean, testName: string) {
    total++;
    if (condition) {
      console.log(`✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${testName}`);
    }
  }

  // 1. Setup Express server instance on ephemeral port
  const app = createServer();
  const server = app.listen(0);
  const port = (server.address() as any).port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // 2. Seed a test application in Supabase candidate_applications
    const testCandidateId = 'AWL-11';
    const testJobUrl = 'https://job-boards.greenhouse.io/test-company/jobs/999999';

    const testField: ScannedField = {
      fieldId: 'why_work_here',
      name: 'why_work_here',
      type: 'textarea',
      label: 'Why do you want to work at our company?',
      isRequired: true,
    };

    const initialApp = await upsertApplication({
      applywizz_id: testCandidateId,
      job_url: testJobUrl,
      company_name: 'Test Company',
      job_title: 'Software Engineer',
      status: 'READY_FOR_REVIEW',
      resolved_fields: [
        {
          fieldId: testField.fieldId,
          name: testField.name,
          type: testField.type,
          label: testField.label,
          value: 'Initial AI answer before edit',
          source: 'ai',
          resolvedByTier: 5,
          confidence: 0.85,
        },
      ],
    });

    assert(initialApp && Boolean(initialApp.id), 'Seeded test application in Supabase');

    // 3. Fire PATCH request to modify field value
    const updatedValue = 'I have deep passion for your mission and engineering culture.';
    const patchUrl = `${baseUrl}/api/applications/${initialApp.id}/fields/${testField.fieldId}`;

    const patchResponse = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: updatedValue }),
    });

    assert(patchResponse.status === 200, `PATCH request succeeded with status 200 (got ${patchResponse.status})`);

    const patchJson: any = await patchResponse.json();
    assert(patchJson.value === updatedValue, 'PATCH returned updated value string');
    assert(patchJson.source === 'manual', 'PATCH returned source: "manual"');
    assert(patchJson.isEdited === true, 'PATCH returned isEdited: true');
    assert(patchJson.confidence === 1.0, 'PATCH returned confidence: 1.0');

    // 4. Verify answer is stored in candidate_qa_bank with source: 'manual'
    const fingerprint = generateFingerprint(testField.label, testField.type);
    const qaEntry = await getAnswer(testCandidateId, fingerprint);

    assert(qaEntry !== null, 'QA bank entry exists for edited question');
    assert(qaEntry?.value === updatedValue, 'QA bank contains updated value');
    assert(qaEntry?.source === 'manual', 'QA bank entry tagged source: "manual"');

    // 5. Test that Tier 1 resolver now resolves this question directly from candidate_qa_bank
    const tier1Resolved = await resolveTier1(testCandidateId, testField);
    assert(tier1Resolved !== null, 'Tier 1 resolver resolves manually edited question');
    assert(tier1Resolved?.value === updatedValue, 'Tier 1 resolves new manual value');
    assert(tier1Resolved?.source === 'supabase', 'Tier 1 resolves with source: "supabase"');
    assert(tier1Resolved?.resolvedByTier === 1, 'Tier 1 resolves with resolvedByTier: 1');

    console.log(`\n🏁 Test Results: ${passed}/${total} passed.`);

    if (passed === total) {
      console.log('🎉 All Phase V2-3 Inline Edit tests passed successfully!');
    } else {
      console.error('❌ Some tests failed.');
      process.exit(1);
    }
  } finally {
    server.close();
  }
}

runPatchTests().catch((err) => {
  console.error('Unhandled test failure:', err);
  process.exit(1);
});
