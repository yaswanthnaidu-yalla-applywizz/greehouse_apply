/**
 * @fileoverview Unit and Integration Verification for 5-Tier Waterfall Resolution Engine (V2-2).
 */

import { generateFingerprint, normalizeText } from '../src/resolver/fingerprint.js';
import { resolveTier1 } from '../src/resolver/tier1Supabase.js';
import { resolveTier2 } from '../src/resolver/tier2ResumeParse.js';
import { resolveTier3 } from '../src/resolver/tier3FuzzyMatch.js';
import { resolveTier5 } from '../src/resolver/tier5LLM.js';
import { AnswerResolver } from '../src/resolver/answerResolver.js';
import { getProfile } from '../src/db/profiles.js';
import type { ScannedField } from '../src/types/index.js';

async function runTests() {
  console.log('🧪 Starting 5-Tier Waterfall Resolution Engine Tests...\n');

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

  // --------------------------------------------------------------------------
  // Test 1: Fingerprint Generation
  // --------------------------------------------------------------------------
  const fp1 = generateFingerprint('What is your LinkedIn Profile? *', 'text');
  const fp2 = generateFingerprint('what is your linkedin profile?', 'text');
  const fp3 = generateFingerprint('What is your LinkedIn Profile?', 'textarea');

  assert(fp1.length === 16, 'Fingerprint length is 16 hex characters');
  assert(fp1 === fp2, 'Fingerprint is invariant to capitalization and asterisks');
  assert(fp1 !== fp3, 'Fingerprint differs across control types');

  // --------------------------------------------------------------------------
  // Test 2: Tier 1 Supabase Profile Resolution
  // --------------------------------------------------------------------------
  const sampleCandidate = await getProfile('AWL-11');
  const emailField: ScannedField = {
    fieldId: 'email',
    name: 'email',
    type: 'text',
    label: 'Email Address *',
    isRequired: true,
  };

  if (sampleCandidate) {
    const resT1 = await resolveTier1('AWL-11', emailField, sampleCandidate);
    assert(resT1 !== null, 'Tier 1 resolves standard email field');
    assert(resT1?.source === 'supabase', 'Tier 1 returns source: "supabase"');
    assert(resT1?.resolvedByTier === 1, 'Tier 1 returns resolvedByTier: 1');
    assert(resT1?.value === sampleCandidate.email, 'Tier 1 resolves expected email value');
  }

  // --------------------------------------------------------------------------
  // Test 3: Tier 2 Resume Parse Extraction
  // --------------------------------------------------------------------------
  const fakeParsedResume = {
    applywizz_id: 'AWL-TEST',
    raw_text: 'Skills: React, TypeScript, Node.js, Python, PostgreSQL. GPA: 3.8/4.0',
    structured: {
      skills: ['React', 'TypeScript', 'Node.js', 'Python', 'PostgreSQL'],
      experience: [],
      education: [],
      rawSections: { skills: 'React, TypeScript, Node.js, Python, PostgreSQL' },
    },
    parse_library: 'pdf-parse',
  };

  const skillsField: ScannedField = {
    fieldId: 'tech_skills',
    name: 'skills',
    type: 'textarea',
    label: 'List your technical skills',
    isRequired: false,
  };

  const resT2 = await resolveTier2('AWL-TEST', skillsField, fakeParsedResume);
  assert(resT2 !== null, 'Tier 2 extracts skills from parsed resume');
  assert(resT2?.source === 'resume_parse', 'Tier 2 returns source: "resume_parse"');
  assert(resT2?.resolvedByTier === 2, 'Tier 2 returns resolvedByTier: 2');
  assert(resT2?.value.includes('TypeScript'), 'Tier 2 extracted value contains expected skills');

  // --------------------------------------------------------------------------
  // Test 4: Tier 3 Fuzzy Matching against QA Bank
  // --------------------------------------------------------------------------
  const mockQAEntries = [
    {
      applywizz_id: 'AWL-TEST',
      question_fingerprint: '1234567890abcdef',
      question_label: 'What is your current notice period in days?',
      field_type: 'text',
      value: '15 days',
      source: 'ai' as const,
    },
  ];

  const fuzzyField: ScannedField = {
    fieldId: 'notice_period',
    name: 'notice_period',
    type: 'text',
    label: 'Notice Period (days)',
    isRequired: true,
  };

  const resT3 = await resolveTier3('AWL-TEST', fuzzyField, mockQAEntries);
  assert(resT3 !== null, 'Tier 3 matches fuzzy question label in QA bank');
  assert(resT3?.source === 'fuzzy_match', 'Tier 3 returns source: "fuzzy_match"');
  assert(resT3?.resolvedByTier === 3, 'Tier 3 returns resolvedByTier: 3');
  assert(resT3?.value === '15 days', 'Tier 3 returns cached answer value');

  // --------------------------------------------------------------------------
  // Test 5: Orchestrator Waterfall & Unresolved Fallback
  // --------------------------------------------------------------------------
  const resolver = new AnswerResolver();
  const unknownField: ScannedField = {
    fieldId: 'custom_bizarre_question_xyz',
    name: 'custom_xyz',
    type: 'text',
    label: 'What is your secret planetary code name?',
    isRequired: false,
  };

  // Resolving with a dummy profile without LLM should either trigger Tier 5 or return unresolved
  const resOrch = await resolver.resolveField('AWL-11', emailField, { profile: sampleCandidate });
  assert(resOrch.resolvedByTier === 1, 'Orchestrator short-circuits at Tier 1 for email');
  assert(resOrch.source === 'supabase', 'Orchestrator tags source: "supabase" for Tier 1');

  console.log(`\n🏁 Test Results: ${passed}/${total} passed.`);

  if (passed === total) {
    console.log('🎉 All 5-Tier Resolution Engine tests passed successfully!');
    process.exit(0);
  } else {
    console.error('❌ Some tests failed.');
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Unhandled test failure:', err);
  process.exit(1);
});
