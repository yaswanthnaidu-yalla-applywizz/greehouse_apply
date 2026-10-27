import assert from 'node:assert/strict';
import { isSemanticEnabled } from '../src/resolver/semanticSearch.js';
import { config } from '../src/config/env.js';

async function runTest() {
  console.log('🧪 Testing Tier 3 Semantic Search OpenRouter binding...');

  const hasKey = Boolean(config.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY);
  const enabled = isSemanticEnabled();

  // When OPENROUTER_API_KEY is absent, semantic search must never be enabled via Bedrock
  const origKey = process.env.OPENROUTER_API_KEY;
  try {
    delete process.env.OPENROUTER_API_KEY;
    (config as any).OPENROUTER_API_KEY = undefined;
    assert.equal(
      isSemanticEnabled(),
      false,
      'isSemanticEnabled must be false when OPENROUTER_API_KEY is missing, ignoring Bedrock'
    );
  } finally {
    process.env.OPENROUTER_API_KEY = origKey;
    (config as any).OPENROUTER_API_KEY = origKey;
  }

  console.log('✅ Semantic Search OpenRouter test passed');
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
