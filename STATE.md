# Project State — Greenhouse Job Application Automation (V2)

## Current Phase
Phase V2: Full Cloud Persistence, 5-Tier Waterfall Resolution, Playwright Live Submissions, CAPTCHA Handling, Proof Lifecycle, Master Integration & UI Restyling

## Phase Status
**COMPLETED** (All Phases V1-1 through V1-6, V2-1 through V2-6, and V2-UI Fully Verified)

---

## 🎯 What's Done in Phase V2

### 1. Phase V2-1: Supabase Migration & Storage Provisioning
- Configured typed Supabase client (`src/db/client.ts`) with service role credentials and resilient error handling.
- Implemented automated schema migration script (`src/db/migrate.ts`, `npm run db:migrate`) creating tables:
  - `profiles`: candidate profiles with parsed structured resume JSON.
  - `scanned_job_templates`: unique Greenhouse DOM schemas with conditional dependencies.
  - `candidate_applications`: pre-filled application instances with status, timestamps, and proof URLs.
  - `candidate_qa_bank`: unified Q&A repository with SHA-256 question fingerprints and source tags.
- Provisioned Supabase Storage buckets: `resumes`, `proofs_web`, and `proofs_dry_run`.
- Implemented modular database accessor helpers (`src/db/profiles.ts`, `src/db/templates.ts`, `src/db/applications.ts`, `src/db/qaBank.ts`, `src/db/index.ts`).

### 2. Phase V2-2: 5-Tier Waterfall Resolution Engine
- Implemented high-fidelity 5-tier answer resolution waterfall in `src/resolver/answerResolver.ts`:
  - **Tier 1 (Supabase / Exact Match)**: Profile attributes & exact fingerprint match in `candidate_qa_bank` (`source: 'supabase'`, `resolvedByTier: 1`).
  - **Tier 2 (Resume Parse Extraction)**: PDF resume parsing via `pdf-parse` (`source: 'resume_parse'`, `resolvedByTier: 2`).
  - **Tier 3 (Fuzzy Match)**: Fuse.js matching against QA bank question labels with threshold $\ge 0.82$ (`source: 'fuzzy_match'`, `resolvedByTier: 3`).
  - **Tier 4 (ApplyWizz API Refetch)**: On-demand live candidate profile refresh (`source: 'api'`, `resolvedByTier: 4`).
  - **Tier 5 (LLM Synthesis)**: OpenRouter, Google Gemini, or OpenAI synthesis combining profile, resume, and job metadata (`source: 'ai'`, `resolvedByTier: 5`).
- Automatic caching and write-back of all answers into `candidate_applications` and `candidate_qa_bank`.

### 3. Phase V2-3: Inline Review & Operator QA Bank PATCH
- Implemented REST API route `PATCH /api/applications/:id/fields/:fieldId` (`src/server/routes/applications.ts`).
- Saves manual overrides to `candidate_applications.resolved_fields` and immediately upserts into `candidate_qa_bank` with `source: 'manual'`.
- Guarantees Tier 1 priority on subsequent runs for any question edited by an operator.
- Interactive UI with keyboard shortcuts (Enter to save, Esc to cancel) in `dashboard/components/EditableFormField.tsx`.

### 4. Phase V2-4: Playwright Submission Engine & CAPTCHA Detection
- Automated form filler (`src/submitter/formFiller.ts`) populating standard inputs, textareas, selects, custom select dropdown search & click, radio buttons, checkboxes, demographic dropdowns, and file upload with humanized jitter (300–800ms).
- Headful dry-run preview (`src/submitter/dryRun.ts`) capturing screenshots to `proofs_dry_run/{appId}_dryrun.png`.
- Automated CAPTCHA detection (`src/submitter/liveSubmit.ts`) identifying Cloudflare Turnstile, reCAPTCHA, and hCaptcha iframes, transitioning status to `CAPTCHA_REQUIRED`, and pausing the session in memory.
- Interactive session resumption (`src/submitter/captchaResume.ts`, `POST /api/applications/:id/resume-submission`) allowing operators to solve CAPTCHAs in headful mode and resume submissions seamlessly.
- 30-second multi-signal confirmation verification (Page Title, DOM confirmation tokens, URL redirects).

### 5. Phase V2-4b: Cascading Field Detection
- Playwright scanner option probing (`src/scanner/playwrightScanner.ts`) filling select/radio controls during scan and tagging newly visible fields with `{ dependsOn, triggerValue }` metadata.
- Form filler dynamic cascade loop (`src/submitter/formFiller.ts`, `src/submitter/cascadeDetector.ts`) detecting unmapped DOM elements after mutations, resolving them via the 5-tier waterfall, and populating them dynamically (up to 3 cycles).

### 6. Phase V2-5: Web Proof Capture & Status Lifecycle
- Full-page screenshot proof capture (`src/submitter/proofCapture.ts`) uploading confirmation screens to Supabase Storage `proofs_web/{appId}_web.png`.
- Formal status lifecycle state machine:
  `READY_FOR_REVIEW` ➔ `DRY_RUN_COMPLETE` ➔ `APPLYING` ➔ `APPLIED` | `FAILED` | `CAPTCHA_REQUIRED`.
- Real-time status polling every 2s during `APPLYING` state in `dashboard/components/ApplicationStatusBadge.tsx`.
- Interactive high-resolution `ProofViewer.tsx` modal with download button and complete metadata.

### 7. Phase V2-6: Master E2E Integration & Standalone CLI
- Master entrypoint `src/index.ts` orchestrating pre-flight bucket validation, migrations, dual-branch ingestion, 5-tier resolution, and dashboard server launch.
- Standalone CLI runners:
  - `src/submitter/runLiveSubmitCli.ts` (`npm run submit`)
  - `src/resolver/runResolver.ts` (`npm run resolve -- --verbose`)
  - `src/scanner/runScan.ts` (`npm run scan`)
  - `src/candidate/runCandidateSync.ts` (`npm run sync:candidates`)
- Standardized `package.json` scripts (`db:migrate`, `scan`, `sync:candidates`, `resolve`, `dry-run`, `submit`, `start`, `test`).
- Master integration test suite `tests/e2eIntegration.test.ts` validating all 7 checkpoints.

### 8. Phase V2-UI: Neo-Brutalist Job Board Aesthetic
- Restyled operator dashboard according to the reference design (`a737b7388a0fdfe18b73aedbdddd2db7.jpg`):
  - Warm cream background `#FFF5EB`.
  - Crisp dark borders `border border-[#1A1A2E]` and hard drop shadows `shadow-[2px_2px_0px_#1A1A2E]`.
  - Coral `#E88474` primary action CTA buttons ("Approve & Submit").
  - Soft Sky Blue `#B8D4E8` secondary action buttons ("Dry-Run").
  - Dynamic Difficulty Badges (`Easy` green `#9AC89A`, `Medium` blue `#B8D4E8`, `Hard` coral `#E88474`).
  - Top navigation bar with ApplyWizz logo mark, `Find Jobs` / `Dashboard` / `Stats` tabs, notification bell, and user avatar.
  - Dedicated `Stats` tab with metric card grid and resolution distribution analytics.

---

## 🧪 Comprehensive Verification Summary

**All automated test suites pass with a 100% success rate (135/135 tests passing, 0 TypeScript compilation errors):**

| Test Suite | File | Passed / Total | Status |
| :--- | :--- | :---: | :---: |
| **Phase V2-6: Master E2E Integration Suite** | `tests/e2eIntegration.test.ts` | **32 / 32** | ✅ Passed |
| **Phase V2-5: Web Proof Capture & Lifecycle** | `tests/proofLifecycle.test.ts` | **32 / 32** | ✅ Passed |
| **Phase V2-4b: Cascading Field Detection** | `tests/cascading.test.ts` | **16 / 16** | ✅ Passed |
| **Phase V2-4: Submissions & Session Resume** | `tests/submissions.test.ts` | **25 / 25** | ✅ Passed |
| **Phase V2-2: 5-Tier Waterfall Resolution** | `tests/resolverWaterfall.test.ts` | **17 / 17** | ✅ Passed |
| **Phase V2-3: Inline Edit & QA Bank PATCH** | `tests/applicationsPatch.test.ts` | **13 / 13** | ✅ Passed |
| **TypeScript Typecheck** | `npm run typecheck` | **0 errors** | ✅ Passed |

---

## 💻 CLI Quickstart

```powershell
# 1. Typecheck
npm run typecheck

# 2. Run master test suite (32/32 passing)
npm test

# 3. Launch unified pipeline & operator dashboard
npm start

# 4. Run answer resolution with verbose tier telemetry
npm run resolve -- --verbose

# 5. Run live submission via CLI
npm run submit -- --applicationId=<UUID> --headful
```
