import { chromium } from 'playwright';
import { fillForm } from '../src/submitter/formFiller.js';
import { resolveTier1 } from '../src/resolver/tier1Supabase.js';
import { resolveTier2 } from '../src/resolver/tier2ResumeParse.js';
import { AnswerResolver } from '../src/resolver/answerResolver.js';
import type { ScannedField } from '../src/types/index.js';

async function runVerification() {
  console.log('=== 4 ISSUES VERIFICATION TEST START ===\n');

  // 1. Verify Cover Letter Prohibition in Tier 1, Tier 2, and AnswerResolver
  console.log('--- 1. Testing Cover Letter Prohibition ---');
  const coverField: ScannedField = {
    fieldId: 'cover_letter',
    name: 'cover_letter',
    type: 'file',
    label: 'Cover Letter',
    isRequired: false,
  };
  const mockProfile: any = {
    applywizz_id: 'AWL-TEST',
    client_name: 'John Doe',
    first_name: 'John',
    last_name: 'Doe',
    email: 'john.doe@example.com',
    phone: '+1 (555) 123-4567',
  };

  const resolver = new AnswerResolver();
  const resCover = await resolver.resolveField('AWL-TEST', coverField, { profile: mockProfile });
  console.log('Cover letter resolved value:', JSON.stringify(resCover.value));
  if (resCover.value !== '') throw new Error('Cover letter resolved value should be empty!');
  console.log('✅ 1. Cover letter resolution verified: Empty string, skipped.');

  // 2. Verify First Name & Phone in Tier 1 and Tier 2
  console.log('\n--- 2. Testing First Name & Phone Normalization ---');
  const fnField: ScannedField = {
    fieldId: 'first_name',
    name: 'first_name',
    type: 'text',
    label: 'First Name *',
    isRequired: true,
  };
  const phoneField: ScannedField = {
    fieldId: 'phone',
    name: 'phone',
    type: 'text',
    label: 'Phone *',
    isRequired: true,
  };

  const resFn = await resolver.resolveField('AWL-TEST', fnField, { profile: mockProfile });
  console.log('First Name resolved:', resFn.value);
  if (resFn.value !== 'John') throw new Error(`Expected John, got ${resFn.value}`);

  const resPhone = await resolver.resolveField('AWL-TEST', phoneField, { profile: mockProfile });
  console.log('Phone resolved (stripped +1):', resPhone.value);
  if (resPhone.value.startsWith('+1') || resPhone.value.startsWith('1')) {
    throw new Error(`Phone should not start with +1! Got: ${resPhone.value}`);
  }
  console.log('✅ 2. First Name and Phone (+1 stripped) verified.');

  // 3. Verify Tier 2 Name extraction from Resume when profile has only ID
  console.log('\n--- 3. Testing Tier 2 Name & Phone extraction from Resume ---');
  const mockResumeRow: any = {
    applywizz_id: 'AWL-TEST-RESUME',
    raw_text: 'Sai Lokesh Veeravalli\nSoftware Engineer\nPhone: +1(732) 723-8516\nEmail: sai@example.com\nEducation\nSt. Francis College Bachelor of Science',
    structured: {},
    parse_failed: false,
  };
  const tier2Fn = await resolveTier2('AWL-TEST-RESUME', fnField, mockResumeRow);
  console.log('Tier 2 First Name from resume:', tier2Fn?.value);
  if (tier2Fn?.value !== 'Sai') throw new Error(`Expected Sai, got ${tier2Fn?.value}`);

  const tier2Phone = await resolveTier2('AWL-TEST-RESUME', phoneField, mockResumeRow);
  console.log('Tier 2 Phone from resume:', tier2Phone?.value);
  if (tier2Phone?.value.includes('+1')) throw new Error(`Tier 2 phone contains +1: ${tier2Phone?.value}`);
  console.log('✅ 3. Tier 2 Resume Name & Phone extraction verified.');

  // 4. Test Live Form Filler with Playwright on Greenhouse Page
  console.log('\n--- 4. Testing Form Filler on Live Greenhouse Page ---');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const testUrl = 'https://job-boards.greenhouse.io/toshibaglobalcommercesolutions/jobs/5227773007';

  try {
    await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    const testApp: any = {
      applywizz_id: 'AWL-28737',
      job_url: testUrl,
      resolved_fields: [
        {
          fieldId: 'first_name',
          name: 'first_name',
          type: 'text',
          label: 'First Name',
          value: 'Sai Lokesh',
        },
        {
          fieldId: 'last_name',
          name: 'last_name',
          type: 'text',
          label: 'Last Name',
          value: 'Veeravalli',
        },
        {
          fieldId: 'email',
          name: 'email',
          type: 'text',
          label: 'Email',
          value: 'sailokesh@example.com',
        },
        {
          fieldId: 'country',
          name: 'country',
          type: 'select',
          label: 'Country',
          value: 'United States',
        },
        {
          fieldId: 'phone',
          name: 'phone',
          type: 'text',
          label: 'Phone',
          value: '+1(732) 723-8516', // Starts with +1, should be stripped!
        },
        {
          fieldId: 'question_12812311007',
          name: 'question_12812311007',
          type: 'select',
          label: 'Are you 18 years of age or older?',
          value: 'Yes',
        },
        {
          fieldId: 'cover_letter',
          name: 'cover_letter',
          type: 'file',
          label: 'Cover Letter',
          value: '',
        },
      ],
    };

    console.log('Running fillForm on live Greenhouse job page...');
    const summary = await fillForm(page, testApp, { minJitterMs: 50, maxJitterMs: 150, maxCascadeCycles: 0 });
    console.log(`FillForm summary: ${summary.filledFields}/${summary.totalFields} fields populated.`);

    // Inspect values on DOM
    const domValues = await page.evaluate(() => {
      const fn = (document.querySelector('#first_name') as HTMLInputElement)?.value;
      const ln = (document.querySelector('#last_name') as HTMLInputElement)?.value;
      const ph = (document.querySelector('#phone') as HTMLInputElement)?.value;
      const countryContainer = document.querySelector('#country')?.closest('.select__control, .select-shell')?.querySelector('.select__single-value')?.textContent || '';
      const q18Text = document.querySelector('#question_12812311007')?.closest('.select__control, .select-shell')?.querySelector('.select__single-value')?.textContent || '';
      return { fn, ln, ph, countryContainer, q18Text };
    });

    console.log('\n--- Live DOM Inspection Results ---');
    console.log('First Name input value:', domValues.fn);
    console.log('Last Name input value:', domValues.ln);
    console.log('Phone input value:', domValues.ph);
    console.log('Country single value text:', domValues.countryContainer);
    console.log('18+ question single value text:', domValues.q18Text);

    if (domValues.fn !== 'Sai Lokesh') throw new Error(`First Name was not populated! Got: "${domValues.fn}"`);
    if (domValues.ln !== 'Veeravalli') throw new Error(`Last Name was not populated! Got: "${domValues.ln}"`);
    if (domValues.ph.startsWith('+1')) throw new Error(`Phone number still has +1! Got: "${domValues.ph}"`);
    if (domValues.q18Text !== 'Yes') throw new Error(`Dropdown question 18+ not selected! Got: "${domValues.q18Text}"`);
    if (!domValues.countryContainer.includes('+1')) throw new Error(`Country +1 not selected! Got: "${domValues.countryContainer}"`);

    console.log('\n🎉 ALL 4 ISSUES FULLY VERIFIED ON LIVE GREENHOUSE DOM!');
  } finally {
    await browser.close();
  }
}

runVerification().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
