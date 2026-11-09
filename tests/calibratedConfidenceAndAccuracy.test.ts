/**
 * Tests for calibrated AI confidence scoring and accurate answer synthesis.
 */

import {
  LLMSynthesizer,
  calculateCalibratedConfidence,
  isUsPersonUnderExportControl,
  parseBatchAnswerResponse,
} from '../src/resolver/llmSynthesizer.js';
import type { ApplyWizzCandidateProfile, ScannedField } from '../src/types/index.js';

async function runTests() {
  console.log('🧪 Calibrated AI Confidence & Accuracy Tests\n');
  let passed = 0;
  let total = 0;

  function assert(condition: boolean, name: string, detail?: string) {
    total++;
    if (condition) {
      console.log(`✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${name} ${detail ? `(${detail})` : ''}`);
    }
  }

  // --- 1. Export Control (EAR / 8 U.S.C. 1324b(a)(3)) Grounding ---
  const f1Profile: ApplyWizzCandidateProfile = {
    applywizzId: 'AWL-TEST-F1',
    clientName: 'Visa Candidate',
    workAuthorization: 'F1',
    requiresSponsorship: true,
    location: 'Austin, Texas, United States',
  };

  const h1bProfile: ApplyWizzCandidateProfile = {
    applywizzId: 'AWL-TEST-H1B',
    clientName: 'H1B Candidate',
    workAuthorization: 'H1B',
    requiresSponsorship: true,
    location: 'San Jose, California, United States',
  };

  const citizenProfile: ApplyWizzCandidateProfile = {
    applywizzId: 'AWL-TEST-CITIZEN',
    clientName: 'Citizen Candidate',
    workAuthorization: 'US Citizen',
    requiresSponsorship: false,
    location: 'New York, NY, United States',
  };

  const greenCardProfile: ApplyWizzCandidateProfile = {
    applywizzId: 'AWL-TEST-GC',
    clientName: 'Green Card Candidate',
    workAuthorization: 'Permanent Resident / Green Card',
    requiresSponsorship: false,
    location: 'Chicago, IL, United States',
  };

  assert(isUsPersonUnderExportControl(f1Profile) === false, 'F-1 visa candidate is NOT a U.S. Person under EAR');
  assert(isUsPersonUnderExportControl(h1bProfile) === false, 'H-1B visa candidate is NOT a U.S. Person under EAR');
  assert(isUsPersonUnderExportControl(citizenProfile) === true, 'US Citizen is a U.S. Person under EAR');
  assert(isUsPersonUnderExportControl(greenCardProfile) === true, 'Permanent Resident is a U.S. Person under EAR');

  const earField: ScannedField = {
    fieldId: 'cerebras_ear',
    name: 'ear_question',
    type: 'radio',
    label:
      'Cerebras products, software, source code, technology, and/or services are subject to the U.S. Export Administration Regulations (EAR)... In order to comply with these regulations, we are asking you to confirm citizenship and permanent residency as defined below:',
    isRequired: true,
    options: [
      'I am a U.S. person – this includes any individual who is a citizen of the United States, a permanent resident alien of the United States, or a protected individual as defined by 8 U.S.C. 1324b(a)(3).',
      'I am not a U.S. person, and I am not a current citizen or permanent resident of Cuba, Iran, North Korea, or Syria.',
      'I am not a U.S. person, and I am a current citizen or permanent resident of Cuba, Iran, North Korea, or Syria.',
    ],
  };

  const synthesizer = new LLMSynthesizer({ provider: 'anthropic', apiKey: '' });
  const jobContext = { title: 'Engineer', company: 'Cerebras Systems' };

  // Even if raw LLM hallucinated "I am a U.S. person", calibration & legal rule must rectify or penalize
  const earResolvedF1 = synthesizer.finalizeRawAnswer(
    'I am a U.S. person – this includes any individual who is a citizen of the United States, a permanent resident alien of the United States, or a protected individual as defined by 8 U.S.C. 1324b(a)(3).',
    earField,
    f1Profile,
    jobContext
  );

  assert(
    earResolvedF1.value ===
      'I am not a U.S. person, and I am not a current citizen or permanent resident of Cuba, Iran, North Korea, or Syria.',
    'F-1 candidate never receives false U.S. Person legal attestation for EAR compliance',
    `got: ${earResolvedF1.value}`
  );
  assert(
    (earResolvedF1.confidence ?? 0) >= 0.95,
    'F-1 EAR answer has verified high calibrated confidence',
    `got: ${earResolvedF1.confidence}`
  );

  // --- 2. Current Employer Extraction & Section Header Blacklist ---
  const profileWithExperience: ApplyWizzCandidateProfile = {
    applywizzId: 'AWL-EXP',
    clientName: 'Experienced Candidate',
    workExperience: [
      {
        company: 'Stripe, Inc.',
        role: 'Senior Software Engineer',
        duration: '2022 - Present',
      },
      {
        company: 'Google',
        role: 'Software Engineer',
        duration: '2020 - 2022',
      },
    ],
  };

  const currentCompanyField: ScannedField = {
    fieldId: 'current_company',
    name: 'current_company',
    type: 'text',
    label: 'Current Company',
    isRequired: true,
  };

  // Raw answer hallucinated a section header or "NONE"
  const resolvedHeader1 = synthesizer.finalizeRawAnswer(
    'Professional Experience',
    currentCompanyField,
    profileWithExperience,
    jobContext
  );
  assert(
    resolvedHeader1.value === 'Stripe, Inc.',
    'Resume section header "Professional Experience" replaced with actual structured company',
    `got: ${resolvedHeader1.value}`
  );

  const resolvedNone = synthesizer.finalizeRawAnswer(
    'NONE',
    currentCompanyField,
    profileWithExperience,
    jobContext
  );
  assert(
    resolvedNone.value === 'Stripe, Inc.',
    '"NONE" current company replaced with actual structured company when work experience exists',
    `got: ${resolvedNone.value}`
  );

  const resolvedCity = synthesizer.finalizeRawAnswer(
    'Richardson, Texas',
    currentCompanyField,
    profileWithExperience,
    jobContext
  );
  assert(
    resolvedCity.value === 'Stripe, Inc.',
    'City name hallucination replaced with actual structured company',
    `got: ${resolvedCity.value}`
  );

  // --- 3. Missing Dropdown Options / Location Question Fails Closed ---
  const thumbtackLocationField: ScannedField = {
    fieldId: 'thumbtack_loc',
    name: 'remote_location',
    type: 'select',
    label:
      'Thumbtack currently supports remote work in a number of locations across the United States, Ontario and the Philippines. Using the drop down list below, please select the location you intend to work from. If you are not currently located in or able to work from a location listed below, please select "Location not listed."',
    isRequired: true,
    options: [], // Options were not scanned / missing
  };

  const resolvedThumbtack = synthesizer.finalizeRawAnswer(
    'Yes',
    thumbtackLocationField,
    f1Profile,
    { title: 'Data Engineer', company: 'Thumbtack' }
  );

  assert(
    resolvedThumbtack.source === 'unresolved' || resolvedThumbtack.value !== 'Yes',
    'Select dropdown without options does not fall back to "Yes" on location question',
    `got source: ${resolvedThumbtack.source}, value: ${resolvedThumbtack.value}`
  );

  // --- 4. Calibrated Confidence Calculation ---
  // High confidence: directly matches candidate profile
  const authField: ScannedField = {
    fieldId: 'auth_q',
    name: 'authorized',
    type: 'radio',
    label: 'Are you authorized to work in the United States?',
    isRequired: true,
    options: ['Yes', 'No'],
  };
  const calibratedAuth = calculateCalibratedConfidence({
    field: authField,
    profile: citizenProfile,
    jobContext,
    matchedOption: 'Yes',
    rawAnswer: 'Yes',
    modelConfidence: 0.9,
  });
  assert(calibratedAuth >= 0.95, 'Profile-backed work auth confidence calibrated to >= 0.95', `got: ${calibratedAuth}`);

  // Low confidence: guessing / model returned low confidence
  const unknownField: ScannedField = {
    fieldId: 'unknown_tool',
    name: 'tool_q',
    type: 'text',
    label: 'How many years of proprietary internal framework X do you have?',
    isRequired: true,
  };
  const calibratedLow = calculateCalibratedConfidence({
    field: unknownField,
    profile: citizenProfile,
    jobContext,
    rawAnswer: '2 years',
    modelConfidence: 0.4,
  });
  assert(calibratedLow < 0.65, 'Uncertain answer calibrated to < 0.65', `got: ${calibratedLow}`);

  // Choice option default is no longer static 0.90 if model gave lower confidence
  const arbitraryChoiceField: ScannedField = {
    fieldId: 'pref_q',
    name: 'shift_pref',
    type: 'select',
    label: 'What is your preferred shift?',
    isRequired: true,
    options: ['Day', 'Night', 'Swing'],
  };
  const calibratedChoice = calculateCalibratedConfidence({
    field: arbitraryChoiceField,
    profile: citizenProfile,
    jobContext,
    matchedOption: 'Day',
    rawAnswer: 'Day',
    modelConfidence: 0.72,
  });
  assert(
    calibratedChoice === 0.72,
    'Model confidence preserved rather than forced to 0.90 for choice options',
    `got: ${calibratedChoice}`
  );

  // --- 5. Batch Response Parsing with Calibrated Per-Answer Confidence ---
  const batchJsonWithConfidence = JSON.stringify({
    answers: [
      { answer: 'Yes', confidence: 0.96 },
      { answer: 'I have not worked at DoorDash', confidence: 0.94 },
      { answer: 'Uncertain answer', confidence: 0.52 },
    ],
  });

  const parsedBatch = parseBatchAnswerResponse(batchJsonWithConfidence, 3);
  assert(
    Array.isArray(parsedBatch) && parsedBatch.length === 3,
    'parseBatchAnswerResponse handles structured answer objects'
  );
  assert(
    parsedBatch?.[0] === 'Yes' && parsedBatch?.[1] === 'I have not worked at DoorDash',
    'parseBatchAnswerResponse extracts answer strings properly'
  );

  console.log(`\n${passed}/${total} passed`);
  if (passed !== total) process.exit(1);
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
