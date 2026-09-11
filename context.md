# 🏛️ Greenhouse Automation — System Context & Technical Reference

**Project:** Greenhouse Job Application Automation (Cloud & Segregated Operator Pipeline)  
**Repository:** `yaswanthnaidu-yalla-applywizz/greehouse_apply`  
**Purpose:** Comprehensive context, architecture, contracts, and operating standards for all autonomous agents and developers working on this codebase.

---

## 🎯 1. What We Are Actually Building & What's Happening

### The Core Problem
ApplyWizz pairs job seekers (candidates) with job opportunities across hundreds of companies using the Greenhouse Applicant Tracking System (ATS). Every company's Greenhouse application form is unique: arbitrary custom questions, required dropdowns, EEOC demographics, visa sponsorship queries, salary expectations, and free-form prompts. Manually filling dozens of these custom forms per candidate every single day is slow, burns hundreds of human hours, and leads to human error or inconsistent candidate representations.

### The Product Vision: Human-in-the-Loop Automation
We are building a production-grade, **human-in-the-loop automated job application and verification pipeline** deployed seamlessly on Railway. It automates 90% of the scraping, field resolution, form filling, and proof verification lifecycle while providing Campus Ambassadors (CAs) and operators with an intuitive dashboard to review, edit, and approve submissions before they go live. 

Crucially, **the system learns from humans**: whenever an operator edits an answer in the dashboard, the system fingerprints that question and saves it to the persistent QA Bank (`candidate_qa_bank`), ensuring subsequent jobs for that candidate or similar questions across candidates resolve with 100% manual confidence.

### End-to-End System Workflow (The 5-Stage Pipeline)

```
 [1. Job Ingestion & Scraping]
       │  • Bulk CSV uploaded or dropzone monitored in Supabase Storage (`csv_uploads`).
       │  • Shortlinks (grnh.se) resolved and canonicalized.
       │  • Headless Playwright scans DOM structure ➔ saves reusable `scanned_job_templates`.
       ▼
 [2. Waterfall Answer Resolution]
       │  • 5-Tier resolution engine runs across candidates and job templates:
       │    Tier 1 (Profile & QA Bank) ➔ Tier 2 (Master Resume PDF) ➔ Tier 3 (Fuzzy Match) ➔ Tier 5 (LLM Synthesis).
       │  • Company email priority enforced (`client.company_email`).
       │  • Binary Yes/No enforced; phone stripped of leading +1; cover letters excluded.
       ▼
 [3. Human-in-the-Loop Operator Review]
       │  • Operators log in via Microsoft Authenticator TOTP MFA.
       │  • Multi-tenancy: Work-History API filters candidate roster for the CA for current IST day (UTC+5:30).
       │  • Operator views pre-filled questions with source tags (`supabase`, `ai`, `manual`) and difficulty badges.
       │  • Operator can edit any answer inline (saving back to QA Bank) and approve the application.
       ▼
 [4. Submitter Engine & Dual Verification]
       │  • Submitter daemon launches headless Chromium container.
       │  • Uploads candidate's master PDF resume from Supabase Storage (`resumes`).
       │  • Interactively fills inputs, selects dropdowns, checks boxes.
       │  • OTP/CAPTCHA hurdle: If triggered, transitions to `OTP_REQUIRED` for human intervention.
       │  • Web Proof: Submits form and captures full-page screenshot ➔ uploaded to `proofs_web`.
       │  • Failure Proof: On failure, captures error screenshot ➔ uploaded to `proofs_failed`.
       ▼
 [5. Zoho Email Confirmation Verification]
           • Zoho Mail Connector (`src/services/zoho-connector.ts`) directly queries candidate's Zoho inbox via REST API.
           • Filters by strict timestamp window: `received_time >= submission_time - 5min AND received_time <= submission_time + 5min`.
           • Filters by company verification: `from_address CONTAINS company_email OR subject CONTAINS company_name`.
           • Returns structured JSON (`from`, `to`, `subject`, `received_at`, `body_text`, `body_html`) — NEVER takes screenshots.
           • Stored in Supabase `candidate_applications.proof_email_json` and rendered interactively by frontend `EmailProofRenderer`.
```

---

## 👥 2. Agent Collaboration & Team Roles

This repository is maintained and developed by a collaborative four-agent team. Every task should clarify dependencies across these boundaries during the planning phase:

| Agent | Core Responsibilities | Key Files / Paths |
| :--- | :--- | :--- |
| **Backend Agent** *(Current Role)* | Server architecture, REST/WebSocket APIs, Supabase DB & Storage, queue daemon, profile management, Railway deployment compatibility, type integrity (`tsc`). | `src/server/`, `src/db/`, `src/services/`, `src/config/` |
| **Frontend Agent** | Web dashboard UI/UX, operator review workflows, responsive layout, component state, form answer editing, proof screenshot rendering, authentication modals. | `dashboard/`, `dashboard/public/index.html`, `dashboard/App.tsx`, `dashboard/components/` |
| **Automation Agent** | Headless Playwright automation, Greenhouse form scraping, multi-tier field resolution, DOM filling sequences, CAPTCHA/OTP detection, submit clicks, proof screenshot capture. | `src/scanner/`, `src/submitter/`, `src/resolver/` |
| **Debugging Agent** | Triage and root-cause analysis for runtime failures, log inspection, proof screenshot diagnostics, database record consistency, edge-case reproduction without synthetic tests. | `output/`, Supabase `candidate_applications` table, container log streams |

---

## 🚨 3. Non-Negotiable Operational Rules

These rules take absolute precedence across all tasks and must be followed without exception:

### A. ApplyWizz API Restriction
- **NEVER CALL THE APPLYWIZZ API WITHOUT EXPLICIT USER PERMISSION.**
  - Endpoint: `https://www.apply-wizz.me/api/get-client-details?applywizz_id=<AWL_ID>`
  - Prioritize local cache (`cache/profiles/{applywizzId}.json`) and Supabase table `profiles`.
  - Never bypass cache or pass `forceRefresh: true` without explicit user sign-off.

### B. No Synthetic Tests & Maximum Token Efficiency
- **NEVER WRITE SYNTHETIC/MOCK TESTS**: Do not write throwaway mock test suites, synthetic HTML fixtures, or artificial test loops.
- **Token Efficiency**: Provide direct, minimal, production-grade code changes and concise responses.
- Real-world validation is performed directly on real flows only when explicitly requested.

### C. Railway Deployment Compatibility
- **All code must deploy and run smoothly on Railway** (`0.0.0.0`, dynamic `process.env.PORT`).
- Headless Playwright flags required: `--headless=new`, `--no-sandbox`, `--disable-dev-shm-usage`, `--disable-setuid-sandbox`.
- Clean build: `npm run build` (`tsc`) must compile with **0 errors**.
- Server start: `node dist/server/index.js`.

### D. Data & Business Rules
- **Company Email Priority**: Candidate submission email **MUST ALWAYS** be `client.company_email`, NEVER personal email (`src/db/profiles.ts: getCompanyEmail`).
- **Binary Yes/No Enforcement**: Binary fields (relocation, sponsorship, privacy agreements) must strictly evaluate to `"Yes"` or `"No"`.
- **No Cover Letters**: Never generate, fill, or upload cover letters.
- **Phone Formatting**: Strip leading `+1` from US numbers. For demo profile `AWL-YASWANTH`, country is strictly `"India"` and code is `"+91"`.

---

## 🏗️ 4. High-Level System Architecture

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 SYSTEM TOPOLOGY                                        │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│  [Operators / Campus Ambassadors via Browser]                                          │
│       │                                                                                │
│       ▼                                                                                │
│  [Railway Express Server (0.0.0.0:$PORT)]                                              │
│       ├── Auth: TOTP MFA (Microsoft Authenticator) + JWT Bearer Middleware             │
│       ├── CA Candidate Segregation: Work-History API (Asia/Kolkata IST Date Engine)    │
│       ├── Single-Page Web Dashboard: dashboard/public/index.html (and React components)│
│       └── REST API Endpoints: /api/auth/*, /api/candidates/*, /api/applications/*      │
│                                                                                        │
│  [Automation Engines]                                                                  │
│       ├── 1. Scanner: Playwright headless Chromium DOM schema extraction               │
│       ├── 2. Segregator: Maps CSV jobs to ApplyWizz candidate IDs & profiles           │
│       ├── 3. 5-Tier Waterfall Resolver: DB QA Bank ➔ PDF Resume ➔ Fuzzy ➔ LLM Tier 5 │
│       ├── 4. Submitter: Playwright form filler, OTP pause, submission proof capture    │
│       └── 5. Verification: Post-submit web screenshots + Zoho confirmation reader      │
│                                                                                        │
│  [Cloud Storage & DB (Supabase)]                                                       │
│       ├── Tables: profiles, scanned_job_templates, candidate_qa_bank, applications     │
│       ├── Storage: proofs_web, proofs_dry_run, proofs_failed, proofs_mail, csv_uploads │
│       └── External: Work-History API, Zoho Mail Connector, OpenRouter LLM               │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 🗄️ 5. Data Layer & Supabase Schema

### Tables

1. **`profiles`**: Master candidate information synced from ApplyWizz / local cache.
   - Key fields: `applywizz_id`, `client_name`, `email` (legacy), `company_email` (primary submission email), `phone`, `location`, `work_authorization`, `resume_text`, `resume_facts`.
2. **`scanned_job_templates`**: Cached Greenhouse job form schemas.
   - Key fields: `job_url`, `company_name`, `job_title`, `fields_schema` (`Array<ScannedField>`), `field_count`, `is_expired`.
3. **`candidate_qa_bank`**: Persistent answer memory.
   - Key fields: `applywizz_id`, `question_fingerprint` (`SHA-256(label + type)[0:16]`), `question_label`, `field_type`, `value`, `source` (`'ai' | 'manual'`), `confidence`.
4. **`candidate_applications`**: Individual job application states & proof URLs.
   - Unique key: `(applywizz_id, job_url)`.
   - Key fields:
     - `status`: `'READY_FOR_REVIEW' | 'DRY_RUN_COMPLETE' | 'QUEUED' | 'APPLYING' | 'APPLIED' | 'FAILED' | 'EXPIRED' | 'OTP_REQUIRED' | 'CAPTCHA_TIMEOUT'`
     - `resolved_fields`: JSONB array snapshot of questions and pre-filled answers.
     - `has_manual_edits`: Boolean flag (manual edits move application to the tail of the submission queue).
     - Proof columns (see Section 6).

### Supabase Storage Buckets

- **`proofs_web`**: Screenshots of confirmation/success web pages (`{appId}_proof.png`).
- **`proofs_dry_run`**: Screenshots of completed forms during dry-run validation (`{appId}_dryrun.png`).
- **`proofs_failed`**: Screenshots captured when submission fails or errors out (`{appId}_failed.png`).
- **`proofs_mail`**: Screenshots of Zoho confirmation emails (`{appId}_mail_proof.png`).
- **`csv_uploads`**: Inbound CSV dropzone for bulk job URL assignments.

---

## 📸 6. Proof Lifecycle & Dual-Cased Serialization

Every application record tracks 4 distinct screenshot verification states:

| Proof Type | DB Columns | Storage Bucket | Helper Functions |
| :--- | :--- | :--- | :--- |
| **Web Confirmation** | `proof_web_url`, `proof_captured_at` | `proofs_web` | `attachProofToApplication`, `setProofUrl` |
| **Dry-Run Validation** | `dry_run_screenshot_url` | `proofs_dry_run` | `setDryRunScreenshotUrl` |
| **Failure Screenshot** | `proof_failed_url`, `proof_failed_captured_at` | `proofs_failed` | `attachFailedProofToApplication`, `setFailedScreenshotUrl` |
| **Zoho Email Proof** | `proof_email_url`, `proof_email_captured_at`, `email_proof_status`, `email_proof_attempted_at` | `proofs_mail` | `attachEmailProofToApplication`, `updateEmailProofStatus` |

### Shared Serializer (`serializeApplicationDto`)
Located in [`src/db/applications.ts`](file:///C:/Users/yaswa/Dev/greehouse_apply/src/db/applications.ts), this shared mapper guarantees that every API response emits dual-cased properties for flawless compatibility across both TypeScript models and legacy dashboard code:
- `proof_web_url` & `proofWebUrl`
- `proof_captured_at` & `proofCapturedAt`
- `proof_failed_url` & `proofFailedUrl`
- `proof_failed_captured_at` & `proofFailedCapturedAt`
- `proof_email_url` & `proofEmailUrl`
- `proof_email_captured_at` & `proofEmailCapturedAt`
- `email_proof_status` & `emailProofStatus`
- `email_proof_attempted_at` & `emailProofAttemptedAt`
- `dry_run_screenshot_url` & `dryRunScreenshotUrl`
- `has_manual_edits` & `hasManualEdits`
- `error_message` & `errorMessage`

---

## 🌐 7. Key API Endpoints

### Application & Review Routes (`src/server/routes/applications.ts`)
- **`GET /api/applications/:id`**: Returns full application detail DTO via `serializeApplicationDto`.
- **`PATCH /api/applications/:id/status`**: Updates status and accepts `proof_failed_url`, `proof_email_url`, `dry_run_screenshot_url`, `error_message`, etc., updating Supabase and memory cache in one call, emitting WebSocket `APPLICATION_FAILED` on worker failure, and returning full serialized DTO.
- **`PATCH /api/applications/:id/fields/:fieldId`**: Updates a single field value, flags `has_manual_edits: true`, and saves to `candidate_qa_bank` with `source: 'manual'`.
- **`POST /api/applications/:id/approve`**: Operator approves form fields for automated submission.
- **`GET /api/applications/notifications`**: Recent submissions with status outcomes.

### Candidate & Queue Routes (`src/server/index.ts`)
- **`GET /api/candidates`**: Returns assigned candidates for the authenticated CA (filtered via Work-History API) or all candidates for admins.
- **`GET /api/candidates/:applywizzId`**: Returns candidate summary with assigned lightweight job queue.
- **`GET /api/candidates/:applywizzId/jobs/*`**: Detailed job application payload (uses `serializeApplicationDto`).
- **`GET /api/candidates/:applywizzId/resume`**: Returns presigned master resume PDF download URL.

### Submission & Submitter Routes (`src/server/routes/submissions.ts`)
- **`POST /api/submissions/dry-run`**: Triggers headless Playwright dry-run, capturing `dry_run_screenshot_url`.
- **`POST /api/submissions/submit`**: Enqueues or immediately submits live application.
- **`POST /api/submissions/resume-captcha`**: Resumes submission after operator enters OTP / solves CAPTCHA.
- **`POST /api/applications/:id/capture-email-proof`**: Triggers structured Zoho confirmation email fetch within `submission_time ± 5min` window with company verification.

### WebSocket & Real-Time Events (`src/server/ws.ts`)
- **`WS /ws`**: Real-time bidirectional socket server mounted on HTTP server. Broadcasts events to all connected operator dashboard sessions:
  - `APPLICATION_FAILED`: `{ type: 'APPLICATION_FAILED', appId, reason, timestamp, companyName, jobTitle, proofFailedUrl }` — triggers instant UI toast/banner alert without polling lag.
  - `APPLICATION_STATUS_CHANGED`: Status lifecycle transitions.

### Auth & Security Routes (`src/server/routes/auth.ts`)
- **`POST /api/auth/login`**: CA / admin authentication. Supports Microsoft Authenticator TOTP QR setup and MFA token validation.
- **`GET /api/auth/me`**: Retrieves current user session and admin privileges.

---

## 🔄 8. 5-Tier Waterfall Resolver (`src/resolver/`)

When generating answers for Greenhouse fields:
1. **Tier 1 (Supabase QA Bank & Profile)**: Exact match from candidate's profile or previous manual operator answers.
2. **Tier 2 (Resume Extraction)**: Regex and semantic pattern extraction against candidate's master PDF resume.
3. **Tier 3 (Fuzzy Match)**: Levenshtein distance and token similarity against historical question variations.
4. **Tier 4 (Retired / Refetch)**: Directly uses cached profile facts; external API refetching is locked behind strict user approval.
5. **Tier 5 (LLM Synthesis)**: OpenRouter / Gemini API generates grounded answers for custom free-form questions using candidate resume facts.

---

## 🛠️ 9. Common Developer Workflows

### Build & Compilation Check
```bash
npm run build
```
*Note: TypeScript build must always succeed with 0 errors.*

### Running the Server Locally
```bash
node dist/server/index.js
# Or in development mode:
npm run dev
```

### Scanning Zoho Connected Accounts
```bash
npm run scan:zoho-connected
```

### Applying Migrations
Migrations live in `src/db/migrations/`:
- `001_add_company_email.sql`
- `002_rename_captcha_to_otp_required.sql`
- `003_add_proof_email_url.sql`
- `004_db_optimization.sql`
- `005_round_robin_queue.sql`
- `006_email_proof_status.sql`
- `007_proof_failed_url.sql` (Failure proof columns + storage RLS policies)
- `008_proof_email_json.sql` (JSONB column for structured Zoho confirmation email)
- `009_add_email_proof_pending_status.sql` (Adds EMAIL_PROOF_PENDING application status enum value)
- `010_realtime_candidate_applications.sql` (Supabase Realtime publication setup)

Run the SQL files in order in the Supabase SQL Editor.

---

## 🤖 10. Automation Agent — Operational Instructions & Handover Guidelines

This section documents the specific runtime contracts, pipelines, and handover procedures for the **Automation Agent** handling Playwright headless automation, live submissions, and email verification.

### A. Submitter Lifecycle & Status Transitions
1. **Form Filling & Multi-Signal Submission**:
   - Primary script: `src/submitter/liveSubmit.ts` (invoked directly or via `src/submitter/queueWorker.ts`).
   - Browser launches in headless Chromium mode using strict Railway-compatible flags:
     `['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--disable-gpu']`.
   - Post-submit signal verification waits up to 30s across DOM tokens, title changes, and URL redirect patterns.

2. **Web Confirmation & Proof Capture**:
   - Upon web verification success, `captureWebProof` captures a full-page confirmation screenshot and uploads it to `proofs_web`.
   - On submission failure or validation errors, `captureFailedScreenshot` captures a full-page failure screenshot and uploads it to `proofs_failed`.

3. **Email Proof Gating (`EMAIL_PROOF_PENDING` ➔ `APPLIED`)**:
   - **Never mark `APPLIED` immediately upon web confirmation.**
   - Once web proof is captured, the application is transitioned to status `'EMAIL_PROOF_PENDING'`.
   - The submitter attempts an initial immediate check (15s timeout) against Zoho Mail.
   - **If matching email found**: attaches `proof_email_json` and promotes status to `'APPLIED'`.
   - **If zero matches**: kicks off `emailProofPoller.startPolling(application)` which retries every 30s for up to 10 minutes.
   - **On 10-minute timeout**: marks `email_proof_status = 'manual_review_needed'`, sets `manual_email_review = true`, and preserves `'EMAIL_PROOF_PENDING'` for operator manual review.

### B. Zoho Mail Confirmation Verification Rules
- **No Screenshots for Emails**: Never take screenshot images of emails; extract structured JSON (`EmailProofJson`) containing `from`, `to`, `subject`, `received_at`, `body_text`, and `body_html`.
- **Timestamp Cutoff**: Strict cutoff verification `received_at >= submitted_at - 2m`. All older emails are skipped. Zoho relative date strings (`"11:25 AM"`, `"Today, 11:25 AM"`, `"Yesterday, 3:45 PM"`) are parsed via `parseZohoEmailTimestamp`.
- **Company Name Normalization**: Strip legal suffixes (`Inc`, `LLC`, `Ltd`, `Corp`, `Technologies`, etc.) via `normalizeCompanySearchTerm` and verify matches across sender domain, from name, subject, and email body via `matchCompanyInEmail`.

### C. Connected Users Scanner (`scripts/scanZohoConnected.ts`)
- Scrapes `https://zoho-mail-reader.onrender.com/` using `ZOHO_READER_EMAIL` / `ZOHO_READER_PASSWORD` (or fallback `ZOHO_CONNECTOR_USER` / `ZOHO_CONNECTOR_PASS`).
- Filters by `"Connected"` status, iterates pagination, deduplicates emails, and saves to `cache/zoho_connected_emails.json`.
- Run via:
  ```bash
  npm run scan:zoho-connected
  ```

### D. Inter-Agent Handover Points
- **To Frontend Agent**:
  - Expose `'EMAIL_PROOF_PENDING'` status badges and wire up `EmailProofModal` to render `proof_email_json.body_text` / `body_html`.
  - When `manual_email_review === true`, display the manual email search button calling `POST /api/applications/:id/capture-email-proof`.
- **To Backend Agent**:
  - Ensure migrations `008_proof_email_json.sql` and `009_add_email_proof_pending_status.sql` are applied in Supabase.
  - Verify that `serializeApplicationDto` propagates `proof_email_json` and `manual_email_review`.
- **To Debugging Agent**:
  - Inspect `[Live Submit]`, `[Email Proof Poller]`, and `[Zoho Reader]` console logs to trace background retry loops and poller terminations.


---

## 🧭 11. Mandatory Backend Agent Operational Instructions

As the **Backend Agent**, you own server architecture, REST/WebSocket APIs, Supabase persistence, queue worker daemon, and candidate synchronization. You must strictly follow these instructions on every task:

### 1. Zero Synthetic Tests & Extreme Token Efficiency
- **NEVER create synthetic/mock test scripts**, mock fixtures, or throwaway test loops.
- Do not bloat responses with speculative code or conversational filler. Keep updates minimal, targeted, and production-grade.

### 2. ApplyWizz API Strict Protection (Rule 1)
- **NEVER execute external HTTP calls to the ApplyWizz API without explicit, real-time user permission.**
- Always read candidate profiles from local cache (`cache/profiles/{applywizzId}.json`) and Supabase table `profiles`.
- If an un-cached candidate is encountered, **log and skip** rather than initiating an outbound request.

### 3. Railway Deployment Compatibility (Zero Windows Dependencies)
- All network listeners must bind to `0.0.0.0` using `process.env.PORT` dynamically.
- Never use Windows-specific path separators or OS-dependent executables (`path.resolve` / `path.join` only).
- Verify TypeScript compilation integrity (`npm run build`) before concluding any task. Zero compilation errors permitted.

### 4. Status Update & Error Handling Protocol
- Whenever updating status to `FAILED`:
  - Always persist `error_message` to `candidate_applications.error_message`.
  - Always emit `{ type: 'APPLICATION_FAILED', appId, reason, timestamp }` via `wsManager.emitApplicationFailed(...)`.
  - Always return the full hydrated DTO via `serializeApplicationDto(...)`.

### 5. Zoho Email Proof Rules (No Screenshots)
- Confirmation emails **MUST NEVER** be captured as screenshots.
- Query Zoho Mail via REST connector (`src/services/zoho-connector.ts`).
- Enforce strict dual-verification:
  1. Window: `received_time >= submission_time - 5min AND received_time <= submission_time + 5min`.
  2. Company match: `from_address CONTAINS company_email OR subject CONTAINS company_name`.
- Persist structured payload in `proof_email_json` JSONB column.

### 6. Candidate Ingestion, Score Filtering & Zoho Gate
- In `src/candidate/segregator.ts`:
  - Discard CSV rows with `score < 20 || score > 60`.
  - Gate candidates using `isZohoConnected(profile.company_email)` from `src/services/zohoConnectedAllowlist.ts`. If not in allowlist, discard from queue with `⛔ Skipping <id> — not in Zoho allowlist`.

