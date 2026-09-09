# 🚀 Context Handover — Greenhouse Job Application Automation

**Generated:** September 9, 2026  
**Repository:** `C:\Users\yaswa\Dev\greehouse_apply` (`main` branch)  
**Target Environment:** Node.js v24.18.0, TypeScript 5.9, Windows PowerShell, Supabase, Playwright, Ollama (`llama3.1:latest`)

---

> [!CAUTION]
> ### 🚨 STRICT OPERATIONAL RULES
> 1. **ApplyWizz API Permission Requirement**:
>    - Endpoint: `https://www.apply-wizz.me/api/get-client-details?applywizz_id=<AWL_ID>`
>    - Every single time candidate profile data is needed, notify the user first and obtain explicit confirmation before executing outbound HTTP requests.
>    - Always check local cache (`cache/profiles/*.json`) and Supabase (`profiles` table) first.
> 2. **NO SYNTHETIC TESTS**:
>    - Never write synthetic/mock tests, throwaway test scripts, or mock HTML fixtures. Stop wasting tokens and time on synthetic tests.
>    - Real-world validation is done directly on real flows only when explicitly requested by the user.
> 3. **Maximum Token Efficiency**:
>    - Write direct, minimal, production-grade code changes only. Keep chat responses extremely concise.

---

## 📌 Executive Summary & Current State

The Greenhouse Job Application Automation platform ingests candidates from CSV, syncs profiles from ApplyWizz (at ingestion time only), scans Greenhouse job postings via Playwright, resolves application questions using a **3-tier offline waterfall** (Tier 1 → Tier 2 → Tier 5), and automates submissions with operator-assisted OTP/CAPTCHA handling.

### Recent Session Achievements

1. **Strict Company Email Domain Enforcement & Full Database Backfill**
   - Implemented `isCompanyEmailDomain()` in `src/db/profiles.ts` to strictly validate `@applywizard.ai`, `@applywizz.ai`, `@applywizz.com`, and `@apply-wizz.me`.
   - Updated `extractCompanyEmailFromPayload()` and `getCompanyEmail()` to reject all personal email domains (`@gmail.com`, `@yahoo.com`, `@outlook.com`, etc.).
   - Added explicit logging in `src/submitter/formFiller.ts`:
     `[Form Filler] 📧 Email field filled with company email: <email> (source: company_email)`
   - Added Step 4c to `formFiller.ts` Safety Sweep to ensure any empty email input on the DOM is filled strictly with a verified company email.
   - **Database Backfill Executed**: Full backfill across all 309 Supabase profile rows:
     - 194 candidates populated with verified `@applywizard.ai` / `@applywizz.*` company emails.
     - 115 candidates without company emails safely sanitized to `NULL` (0 personal emails in `company_email`).

2. **Demo Profile AWL-YASWANTH Country & Phone Code Configuration**
   - Candidate `AWL-YASWANTH` (Yaswanth Naidu Yalla) hardcoded with `country: 'India'`, `country_code: '+91'`, `location: 'Hyderabad, Telangana, India'`, and `company_email: 'yaswanth.yalla@applywizz.com'`.
   - `src/resolver/tier1Supabase.ts` deterministically resolves `country` and `phone_country` fields to `"India"` (using `matchBestOption`).
   - Phone parser strips leading `+91` alongside `+1` so 10-digit Indian numbers (e.g. `9573939153`) fill cleanly without duplicate country prefixes.
   - Synchronized across `src/candidate/applywizzClient.ts`, `src/db/profiles.ts`, `src/dashboard/demoFixtures.ts`, Supabase `profiles`, and local cache `cache/profiles/AWL-YASWANTH.json`.

3. **Post-Submit CAPTCHA Block Detection & Headful Mode**
   - CAPTCHA detection moved strictly **after** submit button click.
   - Triggers only on actual block (challenge keywords in text, URL unchanged, submit button reset state).
   - Headless browser closes and restarts with `headless: false` at current URL, storing the live session in `PAUSED_SESSIONS`.
   - Polls every 500ms for manual CAPTCHA solve (`iframe` gone + submit enabled) and auto-submits.

4. **Alphanumeric OTP Modal & Input Handling**
   - Dashboard modal updated with alphanumeric regex `/[^a-zA-Z0-9]/g` up to 16 characters (e.g. `Aebf0aDc`).
   - Submitter in `src/submitter/liveSubmit.ts` sequentially fills multi-box alphanumeric OTP inputs.

5. **Full Screenshot Proof Lifecycle**
   - Full-page screenshots captured and uploaded to Supabase Storage at 4 critical application stages:
     - Job open: `proofs_job_open/{applicationId}_open.png`
     - Post-submit: `proofs_job_submitted/{applicationId}_submitted.png`
     - Application failure: `proofs_failed/{applicationId}_failed.png`
     - Success / Web proof: `proofs_web/{applicationId}_web.png`

6. **Yes/No Question Enforcement**
   - Binary/relocation questions strictly return `"Yes"` or `"No"` — never location strings or prose (`tier1Supabase.ts` + `llmSynthesizer.ts`).

7. **Status & Type Unification**
   - Unified `ApplicationStatus` across `src/types/index.ts`, `src/db/applications.ts`, and `dashboard/types.ts`:
     `READY_FOR_REVIEW | DRY_RUN_COMPLETE | APPLYING | APPLIED | FAILED | EXPIRED | OTP_REQUIRED | CAPTCHA_TIMEOUT | PENDING`.

---

## 🏛️ Architecture & 3-Tier Waterfall Engine

Resolution sequence inside `src/resolver/answerResolver.ts` (100% offline during resolution — no ApplyWizz calls):

```
Scanned Question
  ├── Cover Letter? ➔ Skip (empty value per policy)
  ├── Tier 1: Supabase Profiles & Exact QA Bank
  │     ├── Phone country / Calling code / Country ➔ Target match (e.g. 'India' / '+91')
  │     ├── Email ➔ Strict company_email (@applywizard.ai / @applywizz.*)
  │     ├── Binary / Relocation ➔ Strict 'Yes' | 'No'
  │     └── Miss + optional? ➔ Leave empty (no LLM cost)
  ├── Tier 2: Resume PDF Text & Binary /URI Extraction
  └── Tier 5: Local Ollama LLM Synthesis (llama3.1)
        └── Writeback to candidate_qa_bank
```

---

## 🔐 OTP/CAPTCHA Submission Flow

```
Operator clicks "Approve & Submit"
  └── POST /api/applications/:id/submit (headless by default)
        ├── Fill form → click submit → wait 2-3s
        ├── Check block: error keywords / URL unchanged / submit button re-enabled
        ├── If CAPTCHA block:
        │     Switch to headful browser { headless: false }
        │     status → OTP_REQUIRED / storePausedSession()
        │     pollCaptchaSolved() (500ms interval) ➔ on solve, auto-clicks submit
        └── If OTP challenge:
              status → OTP_REQUIRED / storePausedSession()
              Dashboard shows alphanumeric OTP modal (e.g. "Aebf0aDc")
              Operator enters code → POST /api/applications/:id/submit-otp
              Bot fills multi-box OTP → confirms submission → captures screenshot
```

---

## 🗄️ Database & Environment Configuration

### `.env` Key Configurations

```env
PORT=3001
NODE_ENV=development

# ApplyWizz Candidate API (ingestion only — requires user permission per call)
APPLYWIZZ_API_URL=https://www.apply-wizz.me/api/get-client-details?applywizz_id=

# LLM Synthesis Provider (Local Ollama)
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_MODEL=llama3.1:latest

# Thresholds & Files
INPUT_CSV_PATH=./greenhouse_only_applywizz_prod(in).csv
OUTPUT_DIR=./output
RESUMES_DIR=./resumes
MAX_JOB_QUESTIONS=23

# Supabase
SUPABASE_URL=<your-project-url>
SUPABASE_SERVICE_KEY=<your-service-key>
SUPABASE_STORAGE_BUCKET_RESUMES=resumes
SUPABASE_STORAGE_BUCKET_PROOFS=proofs_web
```

### Supabase Storage Buckets
- `resumes`: Master PDF resumes.
- `proofs_web`: Submission confirmation screenshots.
- `proofs_job_open`: Pre-fill page open screenshots.
- `proofs_job_submitted`: Post-submit screenshots.
- `proofs_failed`: Failure context screenshots.

---

## 📂 Key Files & Code Locations

| File | Purpose | Key Details |
|---|---|---|
| `src/resolver/answerResolver.ts` | 3-tier waterfall orchestrator | Tier 1 → 2 → 5; optional fields short-circuit after Tier 1 |
| `src/resolver/tier1Supabase.ts` | Tier 1 matching | Strict company email (`@applywizard.ai`), Yes/No binary rules, phone country/dialing codes (`India`/`+91`) |
| `src/resolver/tier2ResumeParse.ts` | Tier 2 PDF parser | `pdf-parse` + raw `/URI` binary regex for hyperlinks |
| `src/resolver/llmSynthesizer.ts` | Tier 5 LLM engine | Ollama client, Yes/No enforcement, reasoning tag stripper |
| `src/submitter/liveSubmit.ts` | Live submit + OTP/CAPTCHA pause | Post-submit block detection, headful switch, auto-submit on CAPTCHA solve, multi-box OTP fill, screenshot capture |
| `src/submitter/proofCapture.ts` | Screenshot proof uploads | Uploads to `proofs_web`, `proofs_job_open`, `proofs_job_submitted`, `proofs_failed` |
| `src/submitter/formFiller.ts` | Playwright form automation | Select2, React-Select, cover letter skip, phone sweeps, company email logging + safety sweep |
| `src/db/profiles.ts` | Candidate profiles repository | `isCompanyEmailDomain`, `getCompanyEmail`, `upsertProfile`, `getProfile` with `AWL-YASWANTH` support |
| `src/db/backfillCompanyEmail.ts` | Profile email backfill | Strict `@applywizard.ai` backfill and personal email sanitization |
| `src/dashboard/demoFixtures.ts` | Dashboard demo data | `AWL-YASWANTH` with PMG job URL, India location, +91 phone code |
| `dashboard/components/SubmissionControls.tsx` | Submit UI + OTP modal | Alphanumeric OTP input (up to 16 chars), CAPTCHA browser open, proof viewer |
| `dashboard/public/index.html` | Served Dashboard SPA | Runtime single-page app (mirrors dashboard components) |

---

## 🧪 Demo Candidate (Dashboard Testing)

Use without running the full pipeline:

| Field | Value |
|---|---|
| ApplyWizz ID | `AWL-YASWANTH` |
| Name | Yaswanth Naidu Yalla |
| Email | `yaswanth.yalla@applywizz.com` (company email) |
| Phone | `9573939153` |
| Country / Code | `India` / `+91` |
| Location | `Hyderabad, Telangana, India` |
| Job URL | `https://job-boards.greenhouse.io/pmg/jobs/8765658002?gh_src=lcrm1uib2us` |
| Resume | `resumes/my-resume.pdf` (must exist locally for upload fields) |

1. Start server: `npm run dashboard` (or `npx tsx src/index.ts --skip-dashboard`)
2. Open `http://localhost:3001`
3. Select **Yaswanth Naidu Yalla** → run Dry-Run or Approve & Submit.

---

## 🛠️ Essential CLI Commands

```powershell
# Build & Verify
npm run build              # TypeScript compilation (must be 0 errors)

# Start Dashboard Server
npm run dashboard          # API + Dashboard SPA on http://localhost:3001

# Run Pipeline
npx tsx src/index.ts --limit=3 --maxJobs=3 --skip-dashboard

# Candidate Database Management
npx tsx src/db/backfillCompanyEmail.ts --fetch-missing  # Backfill company emails
npx tsx src/db/clearCandidateData.ts                   # Full wipe for clean-slate testing
```

---

## 🎯 Recommended Next Steps for Cursor

1. **Persist Paused Sessions Across Server Restarts** *(P1 Reliability)*:
   - `PAUSED_SESSIONS` in `src/submitter/liveSubmit.ts` is in-memory only.
   - Implement database/file serialization or structured recovery via `open-captcha-session`.

2. **Dashboard Build Pipeline Automation** *(P2 Maintainability)*:
   - Introduce a lightweight bundler (Vite or esbuild) so `dashboard/public/index.html` is automatically built from `dashboard/components/*.tsx` rather than manually maintained.

---

## ✅ Completed Tasks (Do Not Re-Implement)

- ✅ **Strict Company Email Domain Priority & Full DB Backfill** (`@applywizard.ai` only, 194 verified, 115 sanitized nulls)
- ✅ **Candidate AWL-YASWANTH Country (`India`) & Phone Code (`+91`) Configuration**
- ✅ **Post-Submit CAPTCHA Block Detection & Headful Mode Switch**
- ✅ **Alphanumeric OTP Modal & Multi-Box Input Filling** (up to 16 chars)
- ✅ **4-Stage Full Screenshot Proof Lifecycle** (`proofs_job_open`, `proofs_job_submitted`, `proofs_failed`, `proofs_web`)
- ✅ **Yes/No Question Strict Enforcement** (Binary only)
- ✅ **Unified ApplicationStatus Types** across DB, backend, and frontend
- ✅ **Cover letter skip policy & Phone prefix stripping**
