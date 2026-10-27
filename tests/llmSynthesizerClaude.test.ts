import assert from 'node:assert/strict';
import { LLMSynthesizer } from '../src/resolver/llmSynthesizer.js';

async function runTest() {
  console.log('🧪 Testing LLMSynthesizer strictly Anthropic Claude...');

  // 1. Default instance must use provider 'anthropic'
  const synth = new LLMSynthesizer({ apiKey: 'mock-key-for-test' });
  const diag = synth.getProviderDiagnostics();
  assert.equal(diag.provider, 'anthropic', `Expected provider 'anthropic', got '${diag.provider}'`);
  assert.ok(
    diag.model.includes('claude') || diag.model.includes('haiku'),
    `Expected Claude model name, got '${diag.model}'`
  );

  // 2. Initializing without apiKey must fail closed when invoking synthesis
  const noKeySynth = new LLMSynthesizer({ apiKey: '' });
  await assert.rejects(
    async () => {
      await noKeySynth.synthesizeBatchAnswers(
        [{ label: 'Sample question', type: 'text' }],
        '',
        'Job description'
      );
    },
    /No LLM provider credentials configured/i,
    'Expected synthesizeBatchAnswers to fail closed without Anthropic API key'
  );

  // 3. Choice option finalization must still work exactly (fail-closed)
  const finalized = synth.finalizeRawAnswer(
    'Option A',
    {
      fieldId: 'q1',
      name: 'q1',
      type: 'select',
      label: 'Select choice',
      options: ['Option A', 'Option B'],
    },
    { applywizzId: 'test', clientName: 'Test' } as any,
    { title: 'Engineer', company: 'Company' }
  );
  assert.equal(finalized.value, 'Option A');
  assert.equal(finalized.source, 'ai');

  // 4. Workspace ID routing
  const synthNoWs = new LLMSynthesizer({ apiKey: 'mock', workspaceId: '' });
  assert.equal((synthNoWs as any).workspaceId, undefined);

  const synthWithWs = new LLMSynthesizer({ apiKey: 'mock', workspaceId: 'ws_123' });
  assert.equal((synthWithWs as any).workspaceId, 'ws_123');

  console.log('✅ LLMSynthesizer Claude test passed');
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
