import assert from 'node:assert/strict';
import { config } from '../src/config/env.js';

async function runTest() {
  console.log('🧪 Testing Claude Resolver Config...');

  // 1. LLM_PROVIDER must be strictly 'anthropic'
  assert.equal(
    config.LLM_PROVIDER,
    'anthropic',
    `Expected LLM_PROVIDER to be 'anthropic', got '${config.LLM_PROVIDER}'`
  );

  // 2. ACTIVE_LLM_API_KEY must not equal OPENROUTER_API_KEY
  if (config.OPENROUTER_API_KEY) {
    assert.notEqual(
      config.ACTIVE_LLM_API_KEY,
      config.OPENROUTER_API_KEY,
      'ACTIVE_LLM_API_KEY must never fall back to OPENROUTER_API_KEY'
    );
  }

  // 3. When CLAUDE_API_KEY is present, ACTIVE_LLM_API_KEY matches it
  if (config.CLAUDE_API_KEY) {
    assert.equal(
      config.ACTIVE_LLM_API_KEY,
      config.CLAUDE_API_KEY,
      'ACTIVE_LLM_API_KEY must match CLAUDE_API_KEY'
    );
  }

  console.log('✅ Claude Resolver Config test passed');
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
