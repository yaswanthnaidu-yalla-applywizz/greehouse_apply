# 💻 Greenhouse Automation — Terminal Commands Reference

This document catalogs all available terminal commands for the Greenhouse Job Application Automation platform. Commands are categorized by operation, with the most critical and frequently used commands highlighted.

---

## ⭐ Essential / Most Important Commands

| Priority | Command | Purpose |
| :--- | :--- | :--- |
| **⭐ MOST USED** | `npm start` | Launches master pipeline (storage bucket check, candidate sync, scanning, answer resolution, and Express dashboard on port `3001`). |
| **⭐ DASHBOARD** | `npm run dashboard` | Starts the Express REST API & Web Dashboard immediately on `http://localhost:3001` without re-running the entire scanner pipeline. |
| **⭐ TARGETED RUN** | `npm run start:sample` | Runs pipeline for candidate `AWL-31428` capped at 10 jobs — ideal for rapid local testing and verification. |
| **⭐ DRY RUN** | `npm run dry-run` | Opens a visible Playwright browser, fills all form fields, and captures a screenshot without submitting. |
| **⭐ LIVE SUBMIT** | `npm run submit` | Runs automated headless submission for the first `READY_FOR_REVIEW` application with CAPTCHA/OTP detection. |
| **⭐ TYPECHECK** | `npm run typecheck` | Validates TypeScript compilation across the entire project with zero emit (`tsc --noEmit`). |
| **⭐ BUILD** | `npm run build` | Compiles TypeScript source to production JavaScript in `./dist/`. |

---

## 🖥️ 1. Master Pipeline & Dashboard Commands

### Full Pipeline Boot
Executes storage provisioning, cache migration, candidate profile syncing, job scanning, 3-tier waterfall resolution, and launches the operator dashboard:
```bash
npm start
# OR directly via tsx:
npx tsx src/index.ts
```

### Dashboard Only (Skip Processing)
Launch the operator interface without re-running form scanning or candidate syncing:
```bash
npm run dashboard
# OR:
npm run start:dashboard
# OR:
npx tsx src/server/index.ts
```
*Access UI at: `http://localhost:3001`*

### Targeted Pipeline Execution (CLI Flags)
You can filter by specific candidate, limit job counts, or bypass individual phases:

```bash
# Target a single candidate by ApplyWizz ID
npx tsx src/index.ts --candidate=AWL-YASWANTH

# Target candidate and limit to 5 jobs
npx tsx src/index.ts --candidate=AWL-31428 --maxJobs=5

# Limit to first 3 candidates from CSV
npx tsx src/index.ts --limit=3

# Skip form scanning (use cached templates only)
npx tsx src/index.ts --skip-scan

# Skip profile sync & resume download
npx tsx src/index.ts --skip-sync

# Skip waterfall resolution
npx tsx src/index.ts --skip-resolve

# Run on a custom HTTP port
npx tsx src/index.ts --port=8080
```

---

## 🚀 2. Live Submissions & Dry-Runs

### Interactive Headful Dry-Run
Populates the form with human-like typing jitter, uploads the resume, and captures a screenshot **without** clicking submit:
```bash
npm run dry-run
# Custom job URL and candidate ID:
npx tsx src/submitter/runUserApplication.ts "https://job-boards.greenhouse.io/company/jobs/12345" AWL-YASWANTH
```

### Live Automated Submission CLI
Submits an application via headless Chromium with anti-detection flags:
```bash
# Submits first READY_FOR_REVIEW application in DB
npm run submit

# Submit a specific application UUID
npx tsx src/submitter/runLiveSubmitCli.ts --applicationId=YOUR_APPLICATION_UUID

# Submit by candidate ID and job URL
npx tsx src/submitter/runLiveSubmitCli.ts --applywizzId=AWL-YASWANTH --jobUrl="https://job-boards.greenhouse.io/..."

# Run in headful (visible browser) mode
npx tsx src/submitter/runLiveSubmitCli.ts --applicationId=YOUR_APPLICATION_UUID --headful
```

---

## 🔍 3. Standalone Pipeline Stages

Each phase of the automation pipeline can be executed independently:

### Branch 1: Greenhouse Job Posting Scanner
Extracts schemas, inputs, and dropdown options from Greenhouse URLs:
```bash
npm run scan
# OR:
npx tsx src/scanner/runScan.ts
```

### Branch 2: Candidate Profile Sync & Resume Downloader
Parses CSV, caches profiles, and downloads master PDF resumes:
```bash
npm run sync:candidates
# OR:
npx tsx src/candidate/runCandidateSync.ts
```

### Answer Resolution Engine
Runs the 3-tier offline waterfall (Tier 1 Supabase/QA Bank ➔ Tier 2 Resume PDF ➔ Tier 5 Ollama LLM):
```bash
npm run resolve
# OR:
npx tsx src/resolver/runResolver.ts
```

### Supabase Storage CSV Dropzone Ingestion
Checks `csv_uploads` bucket for operator-uploaded CSVs, processes candidates, and archives the file:
```bash
npm run ingest:storage
# OR:
npx tsx src/scanner/storageCsvIngestion.ts
```

---

## 🗄️ 4. Database & Migration Commands

### Cache to Supabase Migration
Migrates historical filesystem cache (`cache/profiles/`, `cache/templates/`) into Supabase tables:
```bash
npm run db:migrate
# OR:
npx tsx src/db/migrate.ts
```

### Backfill Company Email
Ensures all profile records prioritize `company_email` over personal email:
```bash
npm run db:backfill-company-email
# OR:
npx tsx src/db/backfillCompanyEmail.ts
```

### Clear Answer History / Reset
Flushes candidate question snapshots when doing fresh benchmark runs:
```bash
npm run db:clear
# OR:
npx tsx src/db/clearAnswers.ts
```

---

## 🧪 5. Verification & Testing

### TypeScript Typechecking
```bash
npm run typecheck
# Strict check with no emit:
npx tsc --noEmit
```

### End-to-End Integration Suite
```bash
npm test
# OR:
npm run test:e2e
# OR:
npx tsx tests/e2eIntegration.test.ts
```

### Targeted Test Suites
```bash
# Proof capture and status lifecycle tests
npx tsx tests/proofLifecycle.test.ts

# Submissions, OTP pause/resume, and dry-run tests
npx tsx tests/submissions.test.ts

# User authentication and TOTP MFA tests
npx tsx tests/auth.test.ts
```

---

## 🐳 6. Docker & Production Commands

### Build Docker Image
```bash
docker build -t greenhouse-apply:latest .
```

### Run Container Locally
```bash
docker run -d \
  -p 3001:3001 \
  --name greenhouse-app \
  --env-file .env \
  greenhouse-apply:latest
```

### Production Build & Execution
```bash
# 1. Compile TypeScript to JavaScript in dist/
npm run build

# 2. Run compiled production server
npm run start:prod
# OR:
node dist/index.js
```

---

## 💡 Pro Tips & Common Workflows

### 🧪 Fast Single-Candidate Validation Workflow
To verify a new candidate without scanning hundreds of jobs:
```bash
npx tsx src/index.ts --candidate=AWL-YASWANTH --maxJobs=2
```

### 🔓 Login & Authenticator Setup
1. Start the server: `npm run dashboard`
2. Open `http://localhost:3001` in your browser
3. Sign up using your email (`yaswanthnaiduyalla@applywizz.ai` is pre-authorized)
4. Receive email OTP via Azure / M365
5. Scan QR code into Microsoft Authenticator
6. Sign in seamlessly with your 6-digit TOTP code
