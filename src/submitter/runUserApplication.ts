/**
 * @fileoverview Live Headful Demonstration Script for User Application.
 *
 * Launches Chromium in headful mode (headless: false) with visual slowing (slowMo),
 * navigates to the target Greenhouse job posting, populates all form fields using
 * the user's details and attaches `resumes/my-resume.pdf`.
 */

import path from 'path';
import fs from 'fs';
import { chromium } from 'playwright';
import { fillForm } from './formFiller.js';
import type { ResolvedField } from '../types/index.js';

async function main() {
  const targetJobUrl = process.argv[2] || 'https://job-boards.greenhouse.io/pmg/jobs/8765658002?gh_src=lcrm1uib2us';
  const resumePath = path.resolve(process.cwd(), 'resumes/my-resume.pdf');

  console.log('================================================================');
  console.log('  🚀 Greenhouse Headful Application Filler Live Demo');
  console.log('================================================================');
  console.log(`• Candidate:  Yaswanth Naidu Yalla`);
  console.log(`• Email:      yaswanthnaidu004@gmail.com`);
  console.log(`• Phone:      +91 9573939153`);
  console.log(`• Location:   Hyderabad, Telangana, India`);
  console.log(`• Target URL: ${targetJobUrl}`);
  console.log(`• Resume PDF: ${resumePath}`);
  console.log('================================================================\n');

  if (!fs.existsSync(resumePath)) {
    console.error(`❌ Resume file not found at ${resumePath}`);
    process.exit(1);
  }

  // Define candidate resolved answers mapped to the target job form
  const resolvedFields: ResolvedField[] = [
    {
      fieldId: 'first_name',
      name: 'first_name',
      type: 'text',
      label: 'First Name',
      value: 'Yaswanth Naidu',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'last_name',
      name: 'last_name',
      type: 'text',
      label: 'Last Name',
      value: 'Yalla',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'email',
      name: 'email',
      type: 'text',
      label: 'Email',
      value: 'yaswanthnaidu004@gmail.com',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'phone',
      name: 'phone',
      type: 'text',
      label: 'Phone',
      value: '+91 9573939153',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'location',
      name: 'candidate_location',
      type: 'location_autocomplete',
      label: 'Candidate Location',
      value: 'Hyderabad, Telangana, India',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'resume',
      name: 'resume',
      type: 'file',
      label: 'Resume/CV',
      value: resumePath,
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'in_which_city_do_you_currently_reside',
      name: 'question_38082676002',
      type: 'text',
      label: 'In which city do you currently reside?',
      value: 'Hyderabad',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'at_pmg_we_fully_embrace_a_collaborative_work_culture_where_emplo',
      name: 'question_38082677002',
      type: 'select',
      label: 'How many days per week are you willing and able to work in-office?',
      value: '5',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'current_or_most_recent_job_title',
      name: 'question_38082678002',
      type: 'text',
      label: 'Current or Most Recent Job Title',
      value: 'Software Engineer',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'current_or_most_recent_company_employer',
      name: 'question_38082679002',
      type: 'text',
      label: 'Current or Most Recent Company/Employer',
      value: 'ApplyWizz / Tech Solutions',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'i_have_read_and_understand_pmg_s_job_applicant_privacy_notice_cl',
      name: 'question_38082680002',
      type: 'select',
      label: "I have read and understand PMG's Job Applicant Privacy Notice",
      value: 'Yes',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'i_consent_to_have_my_personal_data_disclosed_to_other_momentum_g',
      name: 'question_38082681002',
      type: 'select',
      label: 'I consent to have my personal data disclosed',
      value: 'Yes',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'what_are_your_salary_expectations',
      name: 'question_38082682002',
      type: 'text',
      label: 'What are your salary expectations?',
      value: '$130,000',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'do_you_already_reside_in_or_are_you_willing_to_relocate_to_the_c',
      name: 'question_38082683002',
      type: 'select',
      label: 'Do you already reside in or are you willing to relocate',
      value: 'Yes',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'will_you_require_sponsorship_to_work_in_the_united_states_now_or',
      name: 'question_38082684002',
      type: 'select',
      label: 'Will you require sponsorship to work in the United States now or in the future?',
      value: 'Yes',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'are_you_currently_located_in_dallas_tx_or_are_you_willing_to_rel',
      name: 'question_38125012002',
      type: 'select',
      label: 'Are you currently located in Dallas, TX, or are you willing to relocate to Dallas, TX?',
      value: 'Yes',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'are_you_willing_to_come_into_our_dallas_office_4_days_a_week',
      name: 'question_38125013002',
      type: 'select',
      label: 'Are you willing to come into our Dallas office 4 days a week?',
      value: 'Yes',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'do_you_have_at_least_2_years_of_lead_or_management_experience',
      name: 'question_38125240002',
      type: 'select',
      label: 'Do you have at-least 2+ years of Lead or Management experience?',
      value: 'Yes',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'gender',
      name: 'gender',
      type: 'select',
      label: 'Gender',
      value: 'Male',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'hispanic_ethnicity',
      name: 'hispanic_ethnicity',
      type: 'select',
      label: 'Are you Hispanic/Latino?',
      value: 'No',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'race',
      name: 'race',
      type: 'select',
      label: 'Race',
      value: 'Asian',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'veteran_status',
      name: 'veteran_status',
      type: 'select',
      label: 'Veteran Status',
      value: 'I am not a protected veteran',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
    {
      fieldId: 'disability_status',
      name: 'disability_status',
      type: 'select',
      label: 'Disability Status',
      value: 'No, I do not have a disability',
      source: 'manual',
      resolvedByTier: 1,
      confidence: 1.0,
    },
  ];

  console.log('🌐 Launching Chromium browser in visible (headful) mode...');
  const browser = await chromium.launch({
    headless: false,
    slowMo: 60, // Slower interaction so the user can easily observe the filling in real-time
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--start-maximized',
    ],
  });

  const context = await browser.newContext({
    viewport: null, // Adapts to maximized window
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  try {
    console.log(`🌐 Navigating to ${targetJobUrl}...`);
    await page.goto(targetJobUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    console.log('📝 Starting automated form filling with human jitter (300ms - 800ms)...');

    const appRecord = {
      id: 'yaswanth-demo-app',
      applywizz_id: 'my-resume',
      job_url: targetJobUrl,
      status: 'READY_FOR_REVIEW' as const,
      resolved_fields: resolvedFields,
    };

    const summary = await fillForm(page, appRecord, {
      minJitterMs: 250,
      maxJitterMs: 600,
      timeoutMs: 8000,
    });

    console.log('\n================================================================');
    console.log(`  ✅ Form Filling Complete! (${summary.filledFields}/${summary.totalFields} fields filled)`);
    console.log('================================================================');
    console.log('📸 Capturing screenshot of filled form...');
    
    const screenshotPath = path.resolve(process.cwd(), 'output/user_application_headful.png');
    await page.screenshot({ fullPage: true, path: screenshotPath });
    console.log(`🖼️ Screenshot saved to: ${screenshotPath}`);

    console.log('\n👀 Browser is left open for 30 seconds so you can view and inspect your filled form live!');
    await page.waitForTimeout(30000);
  } finally {
    console.log('🏁 Closing headful browser session.');
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('❌ Error executing headful demo:', err);
  process.exit(1);
});
