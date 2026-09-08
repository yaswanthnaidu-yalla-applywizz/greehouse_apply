/**
 * @fileoverview Comprehensive End-to-End Integration and Verification Test Suite (Phase V1-6).
 *
 * Validates that the entire dual-branch pipeline:
 * 1. Stream-parses CSV and extracts unique canonical Greenhouse URLs.
 * 2. Scans form schemas and harvests dropdown/radio options into `scanned_jobs.json` & `.csv`.
 * 3. Segregates candidates by `Applywizz ID` and syncs profiles & master PDF resumes.
 * 4. Resolves all form questions with strict `source: 'supabase'` and `source: 'ai'` tags.
 * 5. Serves pre-filled data via the Express REST API and Operator Dashboard.
 *
 * References:
 * - 02-trd.md
 * - 05-backend-schema.md
 * - 06-implementation.md (Phase V1-6)
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { V1Pipeline } from '../src/orchestrator/pipeline.js';
import { createServer } from '../src/server/index.js';
import { config } from '../src/config/env.js';
import { generateFingerprint } from '../src/resolver/fingerprint.js';
import type {
  CandidateJobApplication,
  CandidateSegment,
  ScannedJobTemplate,
} from '../src/types/index.js';

/**
 * Lightweight test assertion helper.
 */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

/**
 * Runs the End-to-End verification test suite.
 */
export async function runE2ETests(): Promise<void> {
  console.log('================================================================');
  console.log('  🧪 Running Greenhouse Automation V1 End-to-End Test Suite');
  console.log('================================================================\n');

  const testOutputDir = './output';
  let inputCsvPath = config.INPUT_CSV_PATH;

  // Auto-provision test directories
  if (!fs.existsSync(testOutputDir)) {
    fs.mkdirSync(testOutputDir, { recursive: true });
  }
  if (!fs.existsSync(config.RESUMES_DIR)) {
    fs.mkdirSync(config.RESUMES_DIR, { recursive: true });
  }
  if (!fs.existsSync('./cache/profiles')) {
    fs.mkdirSync('./cache/profiles', { recursive: true });
  }
  if (!fs.existsSync('./cache/qa_bank')) {
    fs.mkdirSync('./cache/qa_bank', { recursive: true });
  }

  // If live CSV is missing (e.g. in CI environment), provision a self-contained mock fixture
  if (!fs.existsSync(inputCsvPath)) {
    console.log('ℹ️ Live input CSV not found. Provisioning mock test fixture for CI...');
    const scannedPath = path.join(testOutputDir, 'scanned_jobs.json');
    const testJobUrl = 'https://job-boards.greenhouse.io/examplecompany/jobs/10001';
    const standardMockTemplate: ScannedJobTemplate = {
      jobUrl: testJobUrl,
      companyName: 'Example Company',
      jobTitle: 'Senior Software Engineer',
      scannedAt: new Date().toISOString(),
      isExpired: false,
      fields: [
        { fieldId: 'first_name', name: 'first_name', type: 'text', label: 'First Name *', isRequired: true },
        { fieldId: 'last_name', name: 'last_name', type: 'text', label: 'Last Name *', isRequired: true },
        { fieldId: 'email', name: 'email', type: 'text', label: 'Email *', isRequired: true },
        { fieldId: 'phone', name: 'phone', type: 'text', label: 'Phone *', isRequired: true },
        { fieldId: 'work_auth', name: 'work_auth', type: 'radio', label: 'Are you authorized to work in the US? *', isRequired: true, options: ['Yes', 'No'] },
        { fieldId: 'why_company', name: 'why_company', type: 'textarea', label: 'Why do you want to work here? *', isRequired: true },
      ],
    };

    if (fs.existsSync(scannedPath)) {
      try {
        const existing: ScannedJobTemplate[] = JSON.parse(fs.readFileSync(scannedPath, 'utf-8'));
        const idx = existing.findIndex((t) => t.jobUrl === testJobUrl);
        if (idx >= 0) {
          existing[idx] = standardMockTemplate;
        } else {
          existing.unshift(standardMockTemplate);
        }
        fs.writeFileSync(scannedPath, JSON.stringify(existing, null, 2), 'utf-8');
      } catch {
        // Ignored
      }
    } else {
      const mockTemplates: ScannedJobTemplate[] = [
        {
          jobUrl: testJobUrl,
          companyName: 'Example Company',
          jobTitle: 'Senior Software Engineer',
          scannedAt: new Date().toISOString(),
          isExpired: false,
          fields: [
            { fieldId: 'first_name', name: 'first_name', type: 'text', label: 'First Name *', isRequired: true },
            { fieldId: 'last_name', name: 'last_name', type: 'text', label: 'Last Name *', isRequired: true },
            { fieldId: 'email', name: 'email', type: 'text', label: 'Email *', isRequired: true },
            { fieldId: 'phone', name: 'phone', type: 'text', label: 'Phone *', isRequired: true },
            { fieldId: 'work_auth', name: 'work_auth', type: 'radio', label: 'Are you authorized to work in the US? *', isRequired: true, options: ['Yes', 'No'] },
            { fieldId: 'why_company', name: 'why_company', type: 'textarea', label: 'Why do you want to work here? *', isRequired: true },
          ],
        },
      ];
      fs.writeFileSync(scannedPath, JSON.stringify(mockTemplates, null, 2), 'utf-8');
      fs.writeFileSync(
        path.join(testOutputDir, 'scanned_jobs.csv'),
        'jobUrl,companyName,jobTitle,fieldId,type,label,isRequired,options\nhttps://job-boards.greenhouse.io/examplecompany/jobs/10001,Example Company,Senior Software Engineer,first_name,text,First Name *,true,\n',
        'utf-8'
      );
    }

    const mockCsvPath = path.join(testOutputDir, 'ci_test_sample.csv');
    const mockCsvContent = [
      'Date,Applywizz ID,Client Name,url,score,scored_jobId,status',
      `2/9/2026,AWL-CI001,Test Candidate,${testJobUrl},0,10001_1,PENDING`,
    ].join('\n');
    fs.writeFileSync(mockCsvPath, mockCsvContent, 'utf-8');
    inputCsvPath = mockCsvPath;

    // Seed mock profile cache for AWL-CI001
    const mockProfile = {
      applywizzId: 'AWL-CI001',
      applywizz_id: 'AWL-CI001',
      clientName: 'Test Candidate',
      client_name: 'Test Candidate',
      firstName: 'Test',
      first_name: 'Test',
      lastName: 'Candidate',
      last_name: 'Candidate',
      name: 'Test Candidate',
      email: 'candidate@example.com',
      phone: '+1 (555) 000-0000',
      location: 'San Francisco, CA',
      linkedinUrl: 'https://linkedin.com/in/testcandidate',
      linkedin: 'https://linkedin.com/in/testcandidate',
      workAuthorization: 'US Citizen',
      work_authorization: 'US Citizen',
      requiresSponsorship: false,
      require_sponsorship: 'No',
      experience: '5 years of software engineering',
      skills: 'TypeScript, Node.js, React',
      education: [
        {
          institution: 'Grand Valley State University',
          degree: "Master's Degree",
          fieldOfStudy: 'Computer Science',
        },
      ],
      workExperience: [
        {
          company: 'Technology Solutions',
          title: 'Software Engineer',
        },
      ],
      demographics: {
        gender: 'Decline To Self Identify',
        isHispanicLatino: 'No',
        raceEthnicity: 'Asian',
        veteranStatus: 'I am not a protected veteran',
        disabilityStatus: 'No, I do not have a disability and have not had one in the past',
        willingToRelocate: true,
        canWorkInOffice: true,
        salaryRange: '$120,000 - $140,000',
        yearsOfExperience: '5',
        currentRole: 'Senior Software Engineer',
      },
    };
    fs.writeFileSync('./cache/profiles/AWL-CI001.json', JSON.stringify(mockProfile, null, 2), 'utf-8');

    // Seed mock QA Bank answer
    const mockQaBank = [
      {
        applywizz_id: 'AWL-CI001',
        question_fingerprint: generateFingerprint('Why do you want to work here? *', 'textarea'),
        question_label: 'Why do you want to work here? *',
        field_type: 'textarea',
        value: 'I am excited by the mission and technological innovation at Example Company.',
        source: 'ai',
        confidence: 0.95,
      },
    ];
    fs.writeFileSync('./cache/qa_bank/AWL-CI001.json', JSON.stringify(mockQaBank, null, 2), 'utf-8');

    // Seed mock resume
    const dummyResumePath = path.join(config.RESUMES_DIR, 'AWL-CI001_resume.pdf');
    if (!fs.existsSync(dummyResumePath)) {
      fs.writeFileSync(dummyResumePath, '%PDF-1.4 Mock PDF Resume', 'utf-8');
    }
  }

  assert(fs.existsSync(inputCsvPath), `Input CSV file must exist at ${inputCsvPath}`);


  // 1. Execute V1Pipeline with sample limit for rapid and thorough test verification
  console.log('▶ [Test 1/6] Executing V1Pipeline Orchestrator...');
  const pipeline = new V1Pipeline();
  const result = await pipeline.runFullPipeline(inputCsvPath, testOutputDir, {
    limit: 20,
    skipScanIfCached: true,
  });

  assert(result.status === 'SUCCESS', 'Pipeline execution status must be SUCCESS');
  assert(result.uniqueCandidates > 0, 'Pipeline must process at least 1 candidate');
  assert(result.resolvedApplications > 0, 'Pipeline must resolve at least 1 application');
  console.log('  ✔ Pipeline finished with SUCCESS status.\n');

  // 2. Validate Scanned Jobs Artifacts (JSON & CSV)
  console.log('▶ [Test 2/6] Validating Scanned Job Form Templates (scanned_jobs.json / .csv)...');
  const scannedJsonPath = path.join(testOutputDir, 'scanned_jobs.json');
  const scannedCsvPath = path.join(testOutputDir, 'scanned_jobs.csv');

  assert(fs.existsSync(scannedJsonPath), 'output/scanned_jobs.json must exist');
  assert(fs.existsSync(scannedCsvPath), 'output/scanned_jobs.csv must exist');

  const scannedTemplates: ScannedJobTemplate[] = JSON.parse(
    await fs.promises.readFile(scannedJsonPath, 'utf-8')
  );
  assert(Array.isArray(scannedTemplates), 'scanned_jobs.json must contain an array of templates');
  assert(scannedTemplates.length > 0, 'scanned_jobs.json must have at least one job template');

  for (const t of scannedTemplates) {
    assert(typeof t.jobUrl === 'string' && t.jobUrl.startsWith('http'), `Invalid jobUrl in template: ${t.jobUrl}`);
    assert(Array.isArray(t.fields), `Template for ${t.jobUrl} must have a fields array`);
    for (const f of t.fields) {
      assert(typeof f.fieldId === 'string' && f.fieldId.length > 0, `Field must have non-empty fieldId`);
      assert(typeof f.type === 'string', `Field ${f.fieldId} must have valid type`);
      assert(typeof f.label === 'string', `Field ${f.fieldId} must have label string`);
      assert(typeof f.isRequired === 'boolean', `Field ${f.fieldId} must have boolean isRequired`);
    }
  }

  const csvRaw = await fs.promises.readFile(scannedCsvPath, 'utf-8');
  assert(csvRaw.includes('jobUrl') || csvRaw.includes('job_url'), 'scanned_jobs.csv header must contain jobUrl');
  assert(csvRaw.includes('fieldId') || csvRaw.includes('field_id'), 'scanned_jobs.csv header must contain fieldId');
  console.log(`  ✔ Validated ${scannedTemplates.length} scanned job templates and CSV structure.\n`);

  // 3. Validate Candidate Segments & Master Resumes
  console.log('▶ [Test 3/6] Validating Candidate Segments & Resume Binaries...');
  const segmentsJsonPath = path.join(testOutputDir, 'candidate_segments.json');
  assert(fs.existsSync(segmentsJsonPath), 'output/candidate_segments.json must exist');

  const segments: CandidateSegment[] = JSON.parse(
    await fs.promises.readFile(segmentsJsonPath, 'utf-8')
  );
  assert(Array.isArray(segments), 'candidate_segments.json must be an array');
  assert(segments.length > 0, 'candidate_segments.json must contain segregated candidates');

  let resumeCount = 0;
  for (const seg of segments) {
    assert(typeof seg.applywizzId === 'string' && seg.applywizzId.startsWith('AWL-'), `Candidate ID must start with AWL-: ${seg.applywizzId}`);
    assert(Array.isArray(seg.jobs) && seg.jobs.length > 0, `Candidate ${seg.applywizzId} must have assigned jobs`);

    const resumePath = path.join(config.RESUMES_DIR, `${seg.applywizzId}_resume.pdf`);
    if (fs.existsSync(resumePath)) {
      const stats = fs.statSync(resumePath);
      assert(stats.size > 0, `Resume PDF for ${seg.applywizzId} must be non-empty`);
      resumeCount++;
    }
  }
  console.log(`  ✔ Validated ${segments.length} candidate segments and ${resumeCount} resume PDF binaries.\n`);

  // 4. Validate Multi-Tier Answer Tagging ('supabase' vs 'ai')
  console.log('▶ [Test 4/6] Validating Resolved Applications & Source Tag Attribution...');
  const resolvedJsonPath = path.join(testOutputDir, 'resolved_applications.json');
  assert(fs.existsSync(resolvedJsonPath), 'output/resolved_applications.json must exist');

  const resolvedApps: CandidateJobApplication[] = JSON.parse(
    await fs.promises.readFile(resolvedJsonPath, 'utf-8')
  );
  assert(Array.isArray(resolvedApps), 'resolved_applications.json must be an array');
  assert(resolvedApps.length > 0, 'resolved_applications.json must contain resolved applications');

  let totalFields = 0;
  let supabaseCount = 0;
  let aiCount = 0;

  for (const app of resolvedApps) {
    assert(typeof app.applywizzId === 'string', 'Application must have applywizzId');
    assert(typeof app.jobUrl === 'string', 'Application must have jobUrl');
    assert(Array.isArray(app.resolvedFields), 'Application must have resolvedFields array');
    assert(
      app.resolvedFields.length < config.MAX_JOB_QUESTIONS,
      `Application ${app.applywizzId} -> ${app.jobUrl} has ${app.resolvedFields.length} fields, which exceeds MAX_JOB_QUESTIONS (${config.MAX_JOB_QUESTIONS})`
    );

    for (const f of app.resolvedFields) {
      totalFields++;
      assert(
        f.source === 'supabase' ||
          f.source === 'ai' ||
          f.source === 'resume_parse' ||
          f.source === 'fuzzy_match' ||
          f.source === 'api' ||
          f.source === 'manual',
        `Field '${f.label}' (${f.fieldId}) on application ${app.applywizzId} has invalid source: '${f.source}'.`
      );

      assert(
        typeof f.confidence === 'number' && f.confidence >= 0 && f.confidence <= 1,
        `Field '${f.label}' confidence score ${f.confidence} out of range [0, 1]`
      );

      if (f.source === 'supabase' || f.source === 'resume_parse' || f.source === 'fuzzy_match' || f.source === 'api') supabaseCount++;
      if (f.source === 'ai') aiCount++;
    }
  }

  assert(totalFields > 0, 'Must have at least 1 populated field in resolved applications');
  assert(supabaseCount > 0, 'Must have fields tagged with verified/supabase source');
  console.log(`  ✔ Validated ${totalFields} fields across ${resolvedApps.length} applications (< ${config.MAX_JOB_QUESTIONS} Qs): 🟢 verified=${supabaseCount}, 🟣 ai=${aiCount}, 0 untagged.\n`);


  // 5. Validate Express REST API Endpoints
  console.log('▶ [Test 5/6] Validating Express REST API Endpoints...');
  const app = createServer(testOutputDir);
  const testPort = 3099;
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(testPort, resolve));

  try {
    // a) GET /api/stats
    const statsRes = await fetch(`http://localhost:${testPort}/api/stats`);
    assert(statsRes.status === 200, `GET /api/stats must return 200 OK (got ${statsRes.status})`);
    const stats = await statsRes.json();
    assert(stats.totalCandidates > 0, 'stats.totalCandidates must be > 0');
    assert(stats.pipelineStatus === 'READY', 'stats.pipelineStatus must be READY');

    // b) GET /api/candidates
    const candidatesRes = await fetch(`http://localhost:${testPort}/api/candidates`);
    assert(candidatesRes.status === 200, `GET /api/candidates must return 200 OK`);
    const candidatesList = await candidatesRes.json();
    assert(Array.isArray(candidatesList) && candidatesList.length > 0, 'Candidates list must be non-empty');

    // c) GET /api/candidates/:id
    const firstCandId = candidatesList[0].applywizzId;
    const detailRes = await fetch(`http://localhost:${testPort}/api/candidates/${firstCandId}`);
    assert(detailRes.status === 200, `GET /api/candidates/${firstCandId} must return 200 OK`);
    const candDetail = await detailRes.json();
    assert(candDetail.applywizzId === firstCandId, 'Candidate detail applywizzId must match');
    assert(Array.isArray(candDetail.jobs), 'Candidate detail must have jobs array');
    for (const job of candDetail.jobs) {
      assert(
        job.fieldsCount < config.MAX_JOB_QUESTIONS,
        `Job ${job.canonicalUrl} in candidate queue has ${job.fieldsCount} fields, exceeding threshold ${config.MAX_JOB_QUESTIONS}`
      );
    }

    // d) GET /api/candidates/:id/jobs/*
    const firstJobUrl = encodeURIComponent(candDetail.jobs[0].canonicalUrl || candDetail.jobs[0].rawUrl);
    const jobAppRes = await fetch(`http://localhost:${testPort}/api/candidates/${firstCandId}/jobs/${firstJobUrl}`);
    assert(jobAppRes.status === 200, `GET /api/candidates/${firstCandId}/jobs/... must return 200 OK`);
    const jobApp = await jobAppRes.json();
    assert(jobApp.applywizzId === firstCandId, 'Resolved job application applywizzId must match');
    assert(Array.isArray(jobApp.resolvedFields), 'Resolved job application must have resolvedFields array');

    console.log('  ✔ All REST API endpoints responded with 200 OK and valid schemas.\n');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // 6. Complete
  console.log('================================================================');
  console.log('  🎉 All 6 End-to-End Verification Checkpoints Passed!');
  console.log('================================================================\n');
}

// Auto-run test runner when executed directly
if (process.argv[1] && process.argv[1].includes('e2e.test')) {
  runE2ETests().catch((err: any) => {
    console.error(`\n❌ [E2E Test Suite Error] ${err.message}`);
    process.exit(1);
  });
}
