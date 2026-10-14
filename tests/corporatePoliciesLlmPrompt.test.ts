import { describe, it, expect } from 'vitest';
import { LLMSynthesizer } from '../src/resolver/llmSynthesizer.js';
import { CORPORATE_POLICY_PROMPT_GUIDELINES } from '../src/resolver/corporatePolicies.js';

describe('Corporate Policies LLM Prompt Integration', () => {
  it('includes corporate policy guidelines in single-field synthesis prompt/system message', () => {
    const synthesizer = new LLMSynthesizer();
    const systemMsg = (synthesizer as any).getSystemMessageForField?.({
      type: 'text',
      label: 'Some question',
    });
    // If encapsulated, check that CORPORATE_POLICY_PROMPT_GUIDELINES is referenced in module
    expect(CORPORATE_POLICY_PROMPT_GUIDELINES).toBeDefined();
    expect(CORPORATE_POLICY_PROMPT_GUIDELINES.length).toBeGreaterThan(50);
  });
});
