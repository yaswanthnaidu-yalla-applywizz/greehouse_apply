### Operator Dashboard Actionable Carousel Filtering (2026-10-13 Complete)
- [x] **Carousel Field Filter (`dashboard/utils/fieldFilters.ts`, `tests/fieldFilters.test.ts`):**
  - Implemented `isActionableCarouselField` restricting card carousel mode strictly to:
    1. Required Unresolved fields (`isRequired === true && source === 'unresolved'`)
    2. Required AI-resolved fields (`isRequired === true && source === 'ai'`)
    3. Optional AI-resolved fields (`isRequired === false && source === 'ai'`)
    4. Any question manually edited by the operator (`source === 'manual' || isEdited === true`)
  - Excluded standard identity fields (`first_name`, `last_name`, `email`, `phone`) and non-AI profile/resume resolved fields from the carousel so operators only review high-attention questions.
- [x] **FormRenderer Carousel & Full List Modes (`dashboard/FormRenderer.tsx`, `tests/formRendererFiltering.test.ts`):**
  - Updated card carousel to show filtered questions, with progress bars and approved counts strictly tracking the actionable set.
  - Added clean empty-state card when 0 review questions exist (with direct "Approve & Submit" and "Inspect Full List" affordances).
  - Preserved full 100% field rendering when switched to "Switch to Full List" mode.

### Form Validation & Demographic Fixes for Terminal Failures (2026-10-13 Complete)
- [x] **Demographic Race Labeling & EEO Fallback (`src/resolver/answerResolver.ts`, `src/resolver/tier1Supabase.ts`, `src/submitter/formFiller.ts`):**
  - Broadened race regex patterns to detect Greenhouse standard labels ("Please identify your race", "Please identify your race/ethnicity").
  - Extended Tier 1 structured resolver to check `additional.raceEthnicity` and `payload.demographics` in addition to `additional.race_ethnicity`.
  - Added `resolveEeoFallbackOption` in `formFiller.ts` as a DOM fallback selecting decline-to-state options when a demographic field is strictly required by the employer.
- [x] **Mandatory Cover Letter Gate (`src/resolver/needsReview.ts`):**
  - Added gate routing applications to `READY_FOR_REVIEW` when a cover letter is marked mandatory (`field.required === true`), preventing headless submit timeouts on unsupplied cover letters.
- [x] **Education Cascading Fallbacks (`src/submitter/formFiller.ts`):**
  - Added `applyEducationFieldFallbacks` providing default degree ("Bachelor's Degree"), discipline ("Computer Science"), start date ("2018"), and end date ("2022") when a Greenhouse form renders a mandatory education block with blank subfields.
- [x] **International Phone Number Prefix Safeguard (`src/submitter/formFiller.ts`):**
  - Implemented `sanitizePhoneNumberForSubmission` ensuring that `+1` / `1` prefix stripping only occurs when the raw phone has 11 or more digits, protecting 10-digit international phone numbers from accidental truncation.

### STAR Methodology LLM Synthesis for Open-Ended Questions (2026-10-13 Complete)
- [x] **Behavioral & Motivational Question Classifier (`src/resolver/starClassifier.ts`, `tests/starClassifier.test.ts`):**
  - Created regex classifier detecting open-ended behavioral ("have you worked with", "tell us about a time", "describe a project") and motivational ("why choose our company", "why are you interested in this role") prompts while strictly exempting dropdown, radio, checkbox, demographic/EEO, URL, and salary fields.
- [x] **STAR Prompt Directives in LLMSynthesizer (`src/resolver/llmSynthesizer.ts`, `tests/starPromptSynthesis.test.ts`):**
  - Embedded STAR guidelines into `buildSinglePrompt` and `buildBatchPrompt` / `systemMessage` (CREATIVE RULE).
  - Enforced 50–80 words concise single paragraph without section headers or bullet labels in confident first-person narrative, strictly truthful to candidate history.
- [x] **Context Grounding with QA Bank & Target Company (`src/resolver/candidateEvidence.ts`, `tests/starGroundingContext.test.ts`):**
  - Extended evidence collection to incorporate candidate QA bank answers (`qaBankAnswers`, `qa_bank`) alongside resume facts.
- [x] **Full Regression Verification (`tests/starSynthesisRegression.test.ts`):**
  - Verified behavioral question classification, prompt constraints, and zero regression across existing option matching and routing test suites.

### Submission Retry Safety (2026-10-13)
- [x] Restricted generic automatic retries to explicit `BROWSER_LAUNCH_FAILED` metadata; required-field, unclassified, and thrown failures remain `FAILED` without incrementing `retry_count` or clearing proof fields.
- [x] Required the typed retry reason in `requeueApplicationForRetry()` and removed `OTP_REQUIRED` from its generic source statuses; the dedicated OTP timeout path remains unchanged.
- [x] Added queue-policy regression coverage. Focused queue tests, full unit suite, and `npm run typecheck` pass.

### Signal-to-Noise Logging Optimization (2026-10-13 Complete)
- [x] **Configurable Severity Filtering (`src/utils/logger.ts`, `tests/loggerFiltering.test.ts`):**
  - Implemented and exported `shouldLogMessage(level, configuredLevel)` adhering to severity ordering (`DEBUG: 10`, `INFO: 20`, `WARN: 30`, `ERROR: 40`, `HALT: 50`).
  - Preserved unconditional emission for `WARN`, `ERROR`, and `HALT`.
  - Added environment variable control via `process.env.LOG_LEVEL` (defaults to `INFO`), eliminating low-signal chatter from stdout while keeping milestone stats and health indicators.
- [x] **Submitter & Worker Pipeline Decluttering (`src/submitter/formFiller.ts`, `src/submitter/liveSubmit.ts`):**
  - Downgraded per-keystroke/selector debug logs (`[FormFiller] Stage 1/2/3 match`, `[Sponsorship DEBUG]`, `Country code field → selector`, `Boolean field → clicked`) to `log.debug()`.
  - Retained essential operational stats: resume upload confirmations, form fill completion ratios (`Finished filling form: X/Y successful, Z failed`), and terminal verification/submission statuses.
- [x] **Ingest Pipeline Decluttering (`src/resolver/answerResolver.ts`):**
  - Downgraded per-field resolution attempts (`[Resolver] ✅ T1/T2/T3/T4/T5`, `[Resolver] ❌ T1/T2/T3/T4/T5`) to `log.debug()`.
  - Retained candidate resolution summaries, phase metrics, auto-queue notices, filter-out notices, and batch rollups at `log.info()`.

### Choice Option Matching & Form Filling Fixes (2026-10-13 Complete)
- [x] **Constrained `isSchoolField` & Guarded Option Alignment (`src/resolver/answerResolver.ts`, `src/resolver/tier1Supabase.ts`, `tests/optionMatchingAlignment.test.ts`):**
  - Narrowed `isSchoolField` so that eligibility, authorization, and OPT questions containing "institution" do not get identified as school fields.
  - Guarded `alignResolvedChoice` so questions with discrete choices (e.g. `["Yes", "No", "Not Applicable"]`) never bypass option validation, preventing answers like candidate university names from being saved.
  - Refined `resolveFromPayloadStructured` in Tier 1 to avoid mapping OPT/STEM/sponsorship questions to university names.
- [x] **Unicode Dash & Demographic Decline Matching in Form Filler (`src/submitter/formFiller.ts`, `tests/choiceOptions.test.ts`, `tests/formFillerNormalization.test.ts`):**
  - Added dash normalization in `matchDropdownOption` and `fuzzyOptionTextMatch` to treat en-dash (`\u2013`), em-dash (`\u2014`), and minus sign (`\u2212`) as standard ASCII hyphens (`-`).
  - Added EEO/demographic decline phrase matching so standard self-identification decline values (`"Decline To Self Identify"`) match company-specific dropdown labels (`"Decline to self-identify"`, `"I do not wish to disclose"`, `"Prefer not to say"`).
  - Integrated `isDemographicOrEeoField` into searchable select controls to use fuzzy matching instead of failing on exact match.

### Chromium Crashes & Worker Concurrency Optimization (2026-10-13 Complete)
- [x] **Browser Lifecycle & Concurrency Controller (`src/submitter/browserManager.ts`, `tests/browserManager.test.ts`):**
  - Created centralized `BrowserManager` enforcing global counting semaphore `MAX_CONCURRENT_BROWSERS=5` across background workers, paused OTP sessions, and manual dry-runs.
  - Implemented launch throttling queue with `BROWSER_LAUNCH_COOLDOWN_MS=1500` to space consecutive Chromium process initializations, eliminating CPU/RAM spikes on Railway cgroups.
  - Implemented non-fatal failure handling: eliminated `haltWithDevAlert` (which called `process.exit(1)`) on launch error in `liveSubmit.ts`, replacing with retryable `SUBMIT_PLAYWRIGHT_LAUNCH` diagnostic and status `FAILED` with retry reason `BROWSER_LAUNCH_FAILED`.
  - Added periodic zombie/stale browser sweeper (every 60s) in `server/index.ts` and automated process shutdown cleanup (`closeAll()`).
- [x] **Safe Railway Pro Pool Defaults (`src/config/env.ts`, `src/submitter/submitterPool.ts`, `.env`):**
  - Adjusted `SUBMISSION_POOL_SIZE` and `WORKER_CONCURRENCY` to safe default of `3` lanes, with maximum hard clamp of 6.
  - Added `browser_active_count`, `browser_waiting_count`, and `browser_max_count` metrics to `system_worker_heartbeats`.
- [x] **Unified Paused Session Registry (`src/submitter/liveSubmit.ts`, `src/submitter/otpSession.ts`):**
  - Synchronized paused session cleanup across `PAUSED_SESSIONS` and `activeSubmissions` to guarantee zero browser leaks when OTP sessions resolve or time out.

### Ingest LLM Timeout & Deferred Auto-Queue Submissions (2026-10-13 Complete)
- [x] **Configurable LLM Timeout (`src/config/env.ts`, `src/resolver/llmSynthesizer.ts`):**
  - Added `LLM_TIMEOUT_MS` environment variable (default 30,000ms), replacing the hardcoded 8,000ms client timeout in OpenRouter / OpenAI SDK client initializations.
  - Eliminated `RESOLVE_TIER5_PROVIDER_FAILURE` timeouts on 6–8 question batch syntheses with `google/gemini-2.5-flash`.
- [x] **Tier 4 UUID Rejection for Non-Identifier Fields (`src/resolver/answerResolver.ts`):**
  - Discarded UUID-shaped QA bank answers in `resolveTier3` fuzzy search before accepting matches, preventing false-positive matches of historical applicant IDs into fields like County or Additional links.
- [x] **Deferred Auto-Queue Submissions (`src/resolver/answerResolver.ts`):**
  - Decoupled resolution from immediate enqueueing. Applications resolved during ingest persist initially as `READY_FOR_REVIEW` and buffer in memory (`pendingAutoQueue`).
  - Added public buffer accessors `getPendingAutoQueue()`, `getPendingAutoQueueCount()`, and `flushPendingAutoQueue(): Promise<number>`.
- [x] **CA Notification Filtering & Post-Ingest Flush (`src/services/caNotificationEmail.ts`, `src/orchestrator/pipeline.ts`, `src/resolver/runResolver.ts`):**
  - Updated `groupReadyForReviewByCa` and `sendCaNotificationEmails` with `excludeKeys` (`${applywizz_id}::${job_url}`) to omit pending auto-enqueued applications from CA review notification emails.
  - Added post-ingest auto-queue flush in `Pipeline.run()` after Phase E completes and in `runResolver.ts`, ensuring background submitters do not compete with ingestion for browser and memory resources.

### Remote Supabase DB Profile Contact Normalization & Resume Backfill (2026-10-12 Complete)
- [x] **Profile Data Anomaly Audit (`scripts/auditProfileAnomalies.cjs`):**
  - Audited all 370 profiles in remote Supabase DB (`postgres-db2`, project `rrqsqakctbrhqcoqavoj`).
  - Found 156 empty locations, 209 empty phones, 156 empty countries, 235 empty country codes.
  - Identified 28 rows with US State names in `country` column, 17 rows with non-3-part locations, and 1 invalid phone (< 10 digits).
- [x] **Resume PDF Download, Contact Extraction & 3-Part Location Normalization (`scripts/backfillProfileDataFromPayloadAndResume.cjs`):**
  - Integrated `docs/DASHBOARD CONFIRMATION.csv` priority for operator-verified candidates.
  - Downloaded and parsed candidate resume PDFs on-the-fly from AWS S3 via `axios` + `pdf-parse`, extracting contact numbers and updating `resume_text`.
  - Normalized all candidate locations to canonical 3-part Greenhouse format (`City, State, Country`).
  - Fixed all state-in-country anomalies (28 -> 0) and mapped country dialing codes.
  - Verified final remote DB metrics via MCP `postgres-db2.query`:
    - `with_location`: **369 / 370** (100% of candidates; 1 is test account `CASCADE-TEST-1`)
    - `with_phone`: **369 / 370**
    - `with_country`: **369 / 370**
    - `with_country_code`: **369 / 370**
    - `with_linkedin`: **246 / 369** (extracted from CSV, CRM payloads, and PDF `/URI` hyperlinks; remaining 123 candidates only have portfolio apps and no LinkedIn on file)
    - `non_3part_location`: **0** (100% compliant with Greenhouse `City, State, Country` format)
    - `state_in_country`: **0** (100% resolved)
    - `phone_invalid`: **0** (fixed `AWL-36169` to `+353 89 953 9166`)

### Production Log Error Fixes (2026-10-12 Complete)
- [x] **Process CrashGuard Table Name (`src/server/crashGuard.ts`):**
  - Updated queries from `candidate_applications` to `gh_candidate_applications`.
- [x] **Singleton Supabase Client Poisoning Resolved (`src/server/routes/auth.ts`):**
  - Isolated OTP verification with ephemeral client `createEphemeralAuthClient()`, protecting `service_role` authorization context on `getDbClient()`.
  - Resolved `gh_audit_events` RLS insertion error and false "Application stats are not initialized; apply migration 027_application_stats_consistency.sql" 500 errors.
- [x] **Profiles `resume_storage_path` Fallback & Migration (`src/db/profiles.ts`, `src/db/schema.sql`, `033_add_profiles_resume_storage_path.sql`):**
  - Applied migration `033_add_profiles_resume_storage_path.sql` directly to remote Supabase DB (`postgres-db2`) via MCP.
  - Backfilled existing candidate profiles and reloaded PostgREST schema cache (`NOTIFY pgrst, 'reload schema'`).
  - Added fallback query to `resume_url` when `resume_storage_path` is missing from database schema, eliminating repeated warnings on `/api/candidates`.
- [x] **WorkHistory Multi-Page Pacing & Universal Network Error Retry (`src/services/workHistoryClient.ts`):**
  - Added 250ms inter-page delay (`WORK_HISTORY_PAGE_INTERVAL_MS`).
  - Added browser-like headers (`User-Agent`, `Accept`).
  - Added retry logic for transient HTTP statuses (429, 403, 5xx) and universal error retries on connection resets/DNS blips.
  - Added graceful fallback to accumulated records if late pages fail.

### Remote Supabase DB Profile Sync, Dashboard Confirmation, Zoho & CA Email Backfill (2026-10-12 Complete)
- [x] **Missing Profiles Identified & Migrated:**
  - Audited local sandbox DB (365 profiles) vs remote Supabase DB (`postgres-db2`, 244 profiles).
  - Migrated and inserted all 126 missing candidate profiles into remote `profiles`, bringing remote profile count to **370**.
- [x] **Candidate Profile Location, Phone, LinkedIn Extraction & 3-Part Normalization:**
  - Implemented `scripts/backfillProfileDataFromPayloadAndResume.cjs` extracting missing values from `raw_api_payload` and `resume_text`.
  - Normalized candidate locations to canonical 3-part Greenhouse format (`City, State, Country`).
  - Remote DB profile stats: `with_location: 342`, `with_phone: 282`, `with_country: 342`, `with_linkedin: 235`, `with_github: 79`, `with_ca_email: 370`.
- [x] **Zoho Connected Status Backfilled:**
  - Polled active mailboxes from `https://zoho-mail-reader.onrender.com/api/zoho/ui/users`.
  - Backfilled `zoho_connected` on remote DB: **254 candidates marked `true`**, 116 marked `false`.
- [x] **CA Email Assignments Backfilled:**
  - Paginated ApplyWizz CA work history API (`https://applywizz-ca-management.vercel.app/api/ca/work-history`, 83 pages / 8,266 records).
  - Assigned CA email across all **370 / 370 profiles** (100% coverage, 0 missing).

### Greenhouse Combobox Backing Input Validation & OTP Budget Hardening (2026-10-12 Complete)
- [x] **Remix / React-Select Hidden Backing Input Exclusion (`src/submitter/liveSubmit.ts`):**
  - Updated HTML5 invalid selector to exclude hidden backing inputs (`input:invalid:not([aria-hidden="true"]):not([tabindex="-1"])`), preventing false-positive form fill errors on Greenhouse Remix jobs (e.g., IMC).
- [x] **OTP Budget Increase to 8 Minutes (`src/services/otpResolutionService.ts`):**
  - Raised `OTP_CHALLENGE_TIMEOUT_MS` to 8 minutes (`8 * 60 * 1000`) for slow Greenhouse OTP delivery tolerance.
- [x] **Bidirectional Fast OTP Fallback (`src/services/otpResolutionService.ts`, `src/services/zoho-connector.ts`):**
  - Provider fallback triggers immediately when receiving `not_yet` / `found: false` / `received: false`.
- [x] **Sandbox LLM Provider Override & Gemini 2.5 Flash Support (`src/config/env.ts`, `src/resolver/llmSynthesizer.ts`):**
  - Allowed explicit `LLM_PROVIDER` environment variable overrides in sandbox mode; bumped default Gemini model to `gemini-2.5-flash`.
- [x] **Regression Verification:** Clean typecheck (`tsc --noEmit && npm run typecheck:dashboard`), all unit tests passing.

### Zoho Connected Startup Backfill & End-to-End Filter (2026-10-11 Complete)
- [x] **Startup Backfill in Sandbox Database (`src/db/sandboxClient.ts`):**
  - Added `backfillZohoConnectedProfiles(pool)` directly into `runSandboxMigrations()` after `copyProfilesFromDb2(pool)`.
  - Queries `https://zoho-mail-reader.onrender.com/api/zoho/ui/users`, extracts all connected users, and updates `profiles.zoho_connected = true` for matching `company_email` or `email` (plus demo IDs).
  - Updated `SandboxQueryBuilder` `.update()` and `.delete()` to return `count: res.rowCount`.
- [x] **Strict Candidate Segregation & Ingestion Gating (`src/candidate/segregator.ts`):**
  - Removed sandbox bypass condition (`process.env.SANDBOX !== 'true'`) from candidate segregation.
  - Candidates whose profiles are not Zoho connected are dropped before producing segments (`segmentsMap.delete(id)`), ensuring they are never ingested, resolved, or queued.
- [x] **Robust Connection Status Resolution (`src/services/zohoConnectionCheck.ts`):**
  - Matches on `company_email`, `email`, or pre-flagged `zoho_connected === true`, plus bypass demo candidates.
- [x] **Runtime Dequeue Guardrail (`src/db/applications.ts`):**
  - `getNextQueuedApplicationForRoundRobin` validates `assertApplywizzZohoConnected` before assigning `APPLYING`. Non-connected candidates are safely routed to `READY_FOR_REVIEW`.
- [x] **Regression Tests Passed:** 48/48 tests clean (`tests/zohoConnectedFilter.test.ts`), typecheck clean.

### 5-Phase Submission Hardening Execution (2026-10-11 — salutations.md Complete)
- [x] **Phase 1: Process Crash Guard:**
  - Implemented `isPlaywrightCdpError`, `handleUncaughtException`, `handleUnhandledRejection`, and `sweepStaleApplications` in `src/server/crashGuard.ts`.
  - Installed top-level `setupProcessCrashGuard()` in `src/server/index.ts` before bootstrap imports.
  - Startup and shutdown cleanup sweeps reverting stale `OTP_REQUIRED` / `APPLYING` rows (>10m) to `QUEUED`.
  - Verified with 5/5 unit tests in `tests/crashGuard.test.ts`.
- [x] **Phase 2: Universal Security Code Routing + Company Normalization:**
  - Exported `normalizeCompanyNameForOtp` to strip legal entity suffixes (`Inc.`, `LLC`, `Corp`, etc.).
  - Configured universal routing: all domains (`@gmail.com` and `@applywizard.ai`) call `fetchGmailOtpViaApi` primary.
  - Handled `mailbox_not_connected` to immediately trigger Zoho fallback; `not_yet` continues polling Gmail without switching.
  - Implemented `captureJobOtpScreenshot(page, application)` saving `{applicationId}_otp_challenge.png` in `output/proofs/` the moment `detectOTPField` succeeds.
  - Implemented `captureJobFailedScreenshot(page, application, reason)` saving `{applicationId}_failed_{sanitizedReason}.png` in `output/proofs_failed/`.
  - Verified with 12/12 unit tests in `tests/otpRouting.test.ts`.
- [x] **Phase 3: Form Filler Precision:**
  - Fixed `isCountryCodeField` regex to exclude work authorization and legal eligibility (`/authorized|legally authorized|work authorization|eligible to work|right to work/i`) before country keyword matching.
  - Added `normalizeForCombobox` in `src/submitter/formFiller.ts` for curly apostrophes/quotes and en/em dashes before input typing.
  - Added `applyEducationDegreeFallback` defaulting `Degree*` to `"Bachelor's Degree"` when education is required on DOM and candidate degree is blank.
  - Added `isDemographicOrEeoField` and `resolveEeoFallbackOption` selecting `"Decline to self-identify"` (or first valid option) for mandatory unmapped demographic dropdowns.
  - Added `resolveInvalidFieldLabel` in `detectFormFillingErrors` with container traversal and `aria-labelledby` resolution.
  - Verified with 12/12 unit tests in `tests/formFillerPrecision.test.ts`.
- [x] **Phase 4: Spinner-Aware Submission Confirmation:**
  - Extended base `DEFAULT_SUBMISSION_CONFIRMATION_TIMEOUT_MS`: 45s $\to$ 75s.
  - Added `SPINNER_EXTENDED_TIMEOUT_MS`: 90s.
  - Implemented and exported `isSubmitButtonSpinnerActive(page)` inspecting `.loading`, `aria-busy="true"`, `.spinner`, `svg[class*="animate"]`.
  - Integrated spinner detection loop into `verifySubmissionSignals(page, timeoutMs, spinnerExtendedTimeoutMs)`.
  - Verified with 7/7 unit tests in `tests/spinnerTimeout.test.ts`.
- [x] **Phase 5: Failure Cause Filenames + Error Message Fix:**
  - Added contextual failure screenshot filenames: `{applicationId}_failed_{sanitizedReason}.png`.
  - Intercepted OTP timeout (`OTP_FETCH.*TIMEOUT|ZOHO_INBOX_UNAVAILABLE|POLL_BUDGET_EXHAUSTED`), Gmail security code not found, and mailbox not connected branches before generic `isNetworkError` check in `normalizeOperatorErrorMessage`.
  - Preserved `ECONNREFUSED` generic network error mapping.
  - Verified with 7/7 unit tests in `tests/errorMessages.test.ts`.
- [x] **Full 5-Phase Regression Suite:** 43/43 tests pass, `npm run typecheck` clean (0 errors across src and dashboard). Uncommitted working tree maintained per user instruction.

### 4-Phase Submission Hardening Execution (2026-10-11 — blessings.md Complete)
- [x] **Phase 1: SubmitterPool Backpressure & Idle Gating:**
  - Gated `dispatchQueue` and `dispatchOnce` on `getIdleCount() > 0` in `src/submitter/submitterPool.ts`.
  - Removed intermediate unbounded worker queues (`workerQueues[workerIndex]`).
  - Added graceful shutdown recovery returning in-flight `APPLYING` records to `QUEUED` in PostgreSQL and memory on stop, SIGINT, or SIGTERM.
  - Verified with 5/5 unit tests in `tests/submitterPool.test.ts`.
- [x] **Phase 2: OTP Engine Hardening & Token Bucket Rate Limiting:**
  - Implemented token bucket rate limiter (`mailboxRateLimiter.ts`) capping requests at 3/sec without dropping calls.
  - Integrated rate limiter into `src/services/zoho-connector.ts` before both Zoho and Gmail HTTP requests.
  - Removed premature `break;` on first `not_yet` response in `src/services/otpResolutionService.ts`, sustaining full 300s budget with 4s intervals.
  - Enforced strict domain routing: `@applywizard.ai` exclusively to Zoho, `@gmail.com` exclusively to Gmail.
  - Cleaned up budget exhaustion: calls `clearPausedSession()` to cleanly close the browser and transitions to `RETRY` (or `FAILED` if $\ge 3$) — `OTP_REQUIRED` never persists as a resting state.
  - Verified with 9/9 unit tests in `tests/otpResolution.test.ts`.
- [x] **Phase 3: Form Filler Unicode Normalization & Multi-Stage Matching:**
  - Added `normalizeOptionText()` for curly quotes, en/em dashes, and whitespace normalization.
  - Implemented 3-stage `matchDropdownOption()` (Stage 1 exact normalized $\to$ Stage 2 prefix/contains $\to$ Stage 3 Fuse.js token-set threshold 0.35 / similarity $\ge 0.85$). Safe fail-closed miss without picking random options.
  - Wired into interactive and native select dropdowns in `src/submitter/formFiller.ts`.
  - Enhanced DOM traversal for `input:invalid` in `src/submitter/liveSubmit.ts` to log nearest label, filled value, and options.
  - Verified with 10/10 unit tests in `tests/formFillerNormalization.test.ts`.
- [x] **Phase 4: Tier 5 Corporate Defaults via LLM Context Injection:**
  - Added `CORPORATE_DEFAULT_PATTERNS` and `getCorporateDefaultHint()` in `src/resolver/tier1Supabase.ts`.
  - Updated `ResolvedField` and `BatchQuestion` types with `corporateDefaultHint`.
  - Injected `## Corporate Default Rules` context block in `buildBatchPrompt()` and `buildSinglePrompt()` in `src/resolver/llmSynthesizer.ts`.
  - Dynamic County derivation from candidate location; referral source keyword-priority list enforced.
  - Preserved fail-closed option alignment (`hint != forced answer`).
  - Verified with 11/11 unit tests in `tests/corporateDefaults.test.ts`.
- [x] **Full 4-Phase Regression Suite:** 35/35 tests pass, `npm run typecheck` clean, `npm run build` clean.

### Sandbox Pipeline Diagnostic & Failure Analysis (2026-10-11)
- [x] **Full 1,058 Application Sandbox Audit:**
  - Audited all 1,058 database records across `applywizz_sandbox`: `APPLYING`: 562, `READY_FOR_REVIEW`: 265, `OTP_REQUIRED`: 90, `RETRY`: 56, `EMAIL_PROOF_PENDING`: 37, `APPLIED`: 36, `FAILED`: 12. Total successful: 73 (`36 APPLIED` + `37 EMAIL_PROOF_PENDING`).
- [x] **Identified 4 Critical Systemic Root Causes:**
  - **SubmitterPool Backpressure Defect:** `dispatchQueue()` in `submitterPool.ts` loops infinitely without checking `getIdleCount() > 0`, updating all queued DB records to `APPLYING` in ~2s and buffering them into in-memory worker arrays, causing 562 orphaned `APPLYING` apps when workers stop.
  - **OTP Engine Premature Abort & Domain Routing:** `otpResolutionService.ts` contains a premature `break;` on the first poll miss, aborting the 5-minute budget at 30s and killing the paused Playwright browser. Domain routing is also blind to mailbox domains (routing 67 `@applywizard.ai` Zoho addresses to the Gmail endpoint first).
  - **Form Filler Option Mismatch:** `formFiller.ts` exact-match comparison fails on Unicode curly apostrophes (`Master’s Degree` vs `Master's Degree`) and verbose sentence options, leaving dropdowns on `Select...` and failing HTML5 validation (56 `RETRY` apps).
  - **Phase D Waterfall Fail-Closed:** 253 apps held in `READY_FOR_REVIEW` because corporate trivia questions ("Have you interviewed here before?", "How did you hear about us?", arbitration/AI policy agreements, "County") lack resume context and Tier 5 returns unresolved.
- [x] **Comprehensive Strategic Plan Formulated:**
  - Documented root causes, screenshot proof correlations, and 5-phase hardening plan in `claude_approval.md` for team alignment before code execution.

### Gmail Greenhouse Security Code Integration & Sandbox Hardening (2026-10-11)
- [x] **Gmail OTP Resolution Integration:**
  - Implemented `fetchGmailOtpViaApi` in `src/services/zoho-connector.ts` calling `GET /api/gmail/greenhouse-security-code?email=<candidateEmail>&company=<companyName>`.
  - Configured 4s safe polling interval (~800-1900ms measured latency) with error/timeout resilience.
  - Integrated into `src/services/otpResolutionService.ts` as the primary resolver with automatic fallback to Zoho inbox.
  - Added unit test coverage in `tests/zohoApiOtp.test.ts` (7/7 tests pass).
- [x] **Submission Pipeline & Waterfall Hardening:**
  - Uncapped Tier 1-5 waterfall in `src/resolver/answerResolver.ts` so optional fields cascade through all tiers.
  - Multi-subject degree heuristic in `src/resolver/tier1Supabase.ts` returns `null` on negative matches to avoid premature `'No'`.
  - Unrequired education section rule in `src/submitter/formFiller.ts` bypasses `#school--0`, `#degree--0`, `#discipline--0` if section is optional on DOM.
  - Decoupled worker leases in `src/submitter/liveSubmit.ts` transitioning to `EMAIL_PROOF_PENDING` upon web screenshot confirmation (~25-35s runtime).
  - Maintained stats ledger in `.ai/stats.md` and prepared `handover.md`.

### Auto-Queue Optimization & Resolution Hardening (2026-10-11)
- [x] **Auto-Queue Rate Elevated to 79.5% (841 / 1,058 Applications):**
  - Updated `src/resolver/needsReview.ts` to permit auto-queueing when AI-synthesized fields have confidence $\ge 0.8$.
  - Added safety guard holding applications for operator review if a salary/compensation question was answered negatively ("No", "Decline").
  - Updated `tests/autoQueueAndCaNotification.test.ts` unit tests and verified all pass.
- [x] **Phone Country Resolution & Filling Hardened:**
  - `src/resolver/tier1Supabase.ts`: Resolves country fields (`#country`, `phone_country`, `country_code`) from `profile.country` with fallback to country parsed from `profile.location` or waterfalls downstream without blind defaults.
  - `src/submitter/formFiller.ts`: Modern Greenhouse `#country` dropdown is explicitly identified and populated with candidate country, preventing unselected country form errors.
- [x] **Consent & Agreement Checkboxes Mapped:**
  - `src/resolver/tier1Supabase.ts`: Added mapping for standard legal consent and terms checkboxes (including ScaleOps `question_37471261002[]` and Klaviyo `question_37872860002[]`) resolving to `'true'`.
  - `src/submitter/formFiller.ts`: Added a Safety Sweep step to guarantee any mandatory consent/privacy checkboxes on the active DOM are checked before submission, eliminating form fill validation errors.
- [x] **Truth-Grounded LLM Context:**
  - `src/resolver/llmSynthesizer.ts`: Updated `inferYesNoFromProfile()` to default to `"No"` for prior employment / interview history when absent from candidate resume facts, and `"Yes"` for arbitration/terms agreements and hybrid/office presence requirements.

### Candidate Profiles Sync to postgres-db2 (2026-10-10)

- [x] **Data Consolidation & Cleansing:** Merged 239 rows from 25 sheets of `DASHBOARD CONFIRMATION.xlsx` and `Book1.xlsx`. Stripped operational columns (`Operator`, `Client Name`), replaced placeholder values (`no`, `-`, `n/a`, etc.) with blanks, converted countries to full names (`United States`, `United Kingdom`, `Ireland`, `Australia`), and standardized all locations to Greenhouse-compatible 3-part format: `"{City}, {State/Region}, {Country}"`.
- [x] **Missing Profiles Onboarding:** Handled 3 missing profiles (`AWL-43949`, `AWL-36115`, `AWL-35184`) by querying ApplyWizz API (`get-client-details`), inserting base records into `profiles`, and updating their 7 columns.
- [x] **Safe Database Synchronization:** Executed transactional update across 237 existing profiles on `postgres-db2`. Blank CSV cells strictly avoided overwriting non-null database values. Non-target fields (`education`, `work_experience`, `resume_facts`) remained 100% intact. Total profile count verified at 364.

### Complete CAPTCHA Removal (2026-10-09)
- [x] **Active Behavior Purged:** Removed `CAPTCHA_SELECTORS`, `detectCaptchaIframe`, and post-submit whole-page text heuristics (`security`/`verify`/`challenge`) from `liveSubmit.ts`.
- [x] **Separation of OTP:** Verified complete detachment of OTP workflows from legacy CAPTCHA naming.
- [x] **Schema & Diagnostics:** Purged `SUBMIT_CAPTCHA_BLOCK` and `SUBMIT_CAPTCHA_AMBIGUOUS` from diagnostic categories. Dropped `CAPTCHA_TIMEOUT` from `src/db/schema.sql` and ensured forward migration `030_remove_captcha_state.sql` drops `captcha_retry_count` and maps historical challenge rows to `FAILED`.
- [x] **Test & Documentation Verification:** Added regression tests ensuring passive reCAPTCHA badges cannot divert submissions. All unit tests pass, and full typecheck (`tsc --noEmit && npm run typecheck:dashboard`) passes with 0 errors.

### Selective Feature Restoration Completed (2026-10-09)
- [x] **Feature 1: Retry Counter & Atomic Guards:** Enforced `retry_count` OTP timeout cycle `0 -> 1 -> 2 -> 3 FAILED` (`MAX_SUBMISSION_RETRIES = 3`). Added atomic CAS guards (`expected_status`, `expected_retry_count`) to `updateStatus` and `enqueueApplication` to eliminate race conditions between workers.
- [x] **Feature 2: Failure Diagnostics & Telemetry:** Created `gh_failure_diagnostics` table and migration `029_failure_diagnostics.sql` with automated 90-day retention cleanup. Added searchable, paginated Diagnostics tab in Dev Dashboard and PII-redacted LLM error diagnostics (`getLlmProviderErrorDiagnostics()`).
- [x] **Feature 3: Role-Specific Session Expiry:** Implemented 8-hour operator session lifetime calculated from `sessionLoginAt` (`OPERATOR_SESSION_TTL_SECONDS = 28800`) and 7-day staff sessions (`STAFF_SESSION_TTL_SECONDS = 604800`) across server refresh endpoints and dashboard session managers.
- [x] **Feature 4: Challenge State Deprecation:** Purged legacy `CAPTCHA_REQUIRED` and `CAPTCHA_TIMEOUT` from types, constraints, dashboards, and submission routes. Replaced manual browser solving flows with fast automated OTP resolution. Created migration `030_remove_captcha_state.sql`.
- [x] **Pre-Production Checklist:** Created [`to-do/do before prod/PRE_PROD_CHECKLIST.md`](file:///C:/Users/yaswa/Dev/greehouse_apply/to-do/do%20before%20prod/PRE_PROD_CHECKLIST.md) detailing migration execution and deployment verification steps.
- [x] **Verification:** Full TypeScript typecheck (`tsc --noEmit && npm run typecheck:dashboard`) and production bundle build (`npm run build`) pass cleanly.

### Rollback to Commit 7a35135 & Migration Cleanup (2026-10-08)
- [x] **Complete Working Directory Rollback:** Reverted all working tree modifications via `git restore .` to restore the codebase to clean commit `7a35135` (Oct 7 baseline).
- [x] **Voided Migrations:** Deleted `029_captcha_retry_count.sql`, `030_failure_diagnostics.sql`, and `031_remove_captcha_state.sql`. Provided idempotent SQL commands to undo changes if ever run on remote DBs.
- [x] **Eliminated Auxiliary Subsystems:** Removed unapplied failure diagnostics tables, mailbox submission locks, and experimental retry counter columns.
- [x] **Sandbox Database Reset:** Recreated local PostgreSQL `applywizz_sandbox` clean to match baseline migrations 001–028.
- [x] **Typecheck Verified:** `tsc --noEmit && npm run typecheck:dashboard` passed cleanly with 0 errors.
- [x] **Task Observer Logged:** Documented root cause failures in observations `0030`, `0031`, and `0032`.

### Sandbox CA Assignment
- [x] Sandbox startup normalizes all existing profile and application CA assignments to `yaswanthnaiduyalla@applywizz.ai`; demo seeds and subsequent profile/application writes use the same assignment.
- [x] Sandbox ingestion skips external CA mapping and assigns the dev email to each ingested AWL ID. Production CA mapping is unchanged.
- [x] Added sandbox-versus-production regression coverage; focused tests pass.

### CI Failure Repair (2026-10-07)
- [x] Restored the exported `QuestionLimitExceededError` compatibility type without reintroducing a question cap; corrected dependent TypeScript narrowing errors in submission routes.
- [x] Added the sandbox assignment regression test to the GitHub Actions unit-test list. Full typecheck, production build, and all CI-selected unit tests pass locally.
- [x] Verified GitHub Actions push and pull-request runs both pass all four jobs: Typecheck, Build, Unit Tests, and Container Build.

### Question Limit Removal (2026-10-07)
- [x] Removed the 35-question limit cap per explicit user instruction: [`isWithinSubmissionQuestionLimit`](src/submission/questionLimit.ts), [`assertWithinSubmissionQuestionLimit`](src/submission/questionLimit.ts), and [`isWithinSubmissionQuestionLimitForDisplay`](src/submission/questionLimit.ts) now permit all applications regardless of question count.
- [x] Confirmed the legacy submission eligibility gate (`submissionEligibilityGate.ts` score range 20–60) was already removed in commit `27eb482`; verified zero remaining score or question gates block submission.
- [x] Updated test suite in `tests/questionLimit.test.ts`; `npm run typecheck` and `npm run build` pass cleanly.

### Auto-Queue Routing + Post-Ingest CA Notification (2026-10-07)
- [x] Auto-queue routing: applications where no required field is `source: 'ai'` or `'unresolved'` are automatically enqueued for submission (`status: 'QUEUED'`, `submission_order` assigned via `enqueueApplication`) at resolve time, skipping `READY_FOR_REVIEW`.
- [x] Status preservation on re-ingest: existing in-flight and terminal statuses (`APPLIED`, `FAILED`, `APPLYING`, `QUEUED`, `OTP_*`, `CAPTCHA_*`, `SKIPPED`, `RETRY`, `EMAIL_PROOF_PENDING`, `DRY_RUN_COMPLETE`, `EXPIRED`) are preserved and never overwritten or downgraded to `READY_FOR_REVIEW`.
- [x] Operator queue naturally hides `QUEUED` applications via `filterOperatorApplicationJobs` across modern TSX dashboards, legacy operator shells (`operator-app.jsx`), and candidate job APIs; non-queued applications (`READY_FOR_REVIEW`, `SKIPPED`, `FAILED`, `RETRY`, etc.) remain visible for operator review and manual submission.
- [x] Post-ingest CA notification email: hooked after Phase D in `runFullPipeline` to send one HTML summary email per CA with new `READY_FOR_REVIEW` applications created this run (grouped client and application counts, linking to `https://gh.applywizz.ai`). Optional `CA_NOTIFICATION_EMAIL_OVERRIDE` supported for sandbox testing. Dispatched via Azure/M365 Graph sendMail with try/catch non-blocking error handling.
- [x] Verification: added comprehensive unit test suite in `tests/autoQueueAndCaNotification.test.ts` and enhanced `tests/candidateQueueFilter.test.ts`. Full typecheck (`npm run typecheck`) and production build (`npm run build`) pass cleanly.

### Documentation alignment (2026-10-07)
- [x] Reviewed AGENTS.md and the `.ai` project docs to confirm the active sprint state and shipped status are documented consistently.
- [x] Kept this pass to documentation maintenance only; no user-facing code or infrastructure changes were necessary.

### Proof Image Fallback (2026-10-07)
- [x] Fixed the authenticated proof-image proxy's local fallback to search the bucket-specific output directory, including `output/proofs_failed` for failed screenshots.
- [x] Added storage upload/sign/download and missing-object endpoint diagnostics so cloud failures no longer disappear silently.
- [x] Added a regression test for local proof fallback across web, failed, mail, and dry-run buckets; production storage remains unverified without proof-route requests in the supplied logs.

### Resolver Evidence and Answer Integrity (2026-10-07)
- [x] Country values prefer `additional_information.zip_or_country`; complete choices require a unique shared match, and mismatches continue through all tiers, including Tier 5 for optional standalone country fields.
- [x] Removed synthetic country/calling-code defaults. Phone answers now come only from resume header facts, strip international calling prefixes, and Tier 3–5 phone answers must match the resume number.
- [x] Availability dates use UTC application date + 7 days with captured control/placeholder formats; dropdowns prefer a unique one-week choice, otherwise the first listed option after “Immediately”. TSX and legacy operator views show the expected format.
- [x] Prevented `desired_start_date` from filling month/year component fields with a full date; education month/year values continue through the education-specific resolver.
- [x] Unified conservative unique option matching, corrected misleading Tier 5 failure labels, made batch JSON parsing tolerate valid wrapped arrays while failing closed on malformed data, and rejected UUID-shaped Tier 4 answers for non-identifier fields.
- [x] Added regression tests for country Tier 5 evidence, resume-only phones, availability date/dropdown rules, batch parsing, date metadata in Remix scans, education month/year isolation, and UUID rejection. Focused resolver/scanner tests, `npm run typecheck`, and `npm run build` pass.

### Supabase Storage Probe Client Isolation (2026-10-07)
- [x] Removed the storage-discovery path's ability to replace the process-wide Supabase DB client with whichever key could list a CSV.
- [x] Storage discovery still probes configured keys independently; ingestion operations use the configured service-role database client.
- [x] `npm run typecheck` passes.

### OTP Body-Only Extraction (2026-10-07)
- [x] OTP lookup now fetches the matching email body for code extraction; the subject remains only a Greenhouse/security-email filter.
- [x] Added a regression test confirming a code-like subject is ignored in favor of the message-body OTP.

### Country Answer Integrity (2026-10-07)
- [x] Country fields use `additional_information.zip_or_country` before profile country and require a matching captured choice for select/radio controls.
- [x] Country option mismatches return a Tier 1 miss and continue through the normal resolver tiers instead of inventing an answer or being excluded from Tier 5.
- [x] Removed candidate-ID and generic country/calling-code defaults from profile normalization, persistence, and Tier 1 matching.
- [x] Added resolver regressions for absent country data, candidate-ID inference, payload precedence, option mismatches, incomplete choices, and country mentions inside sponsorship questions; focused resolver tests and `npm run typecheck` pass.

### Apple Music Dark Mode Retheme Across All Dashboards (2026-10-06)
- [x] Rethemed all modern Vite TSX dashboard components (`App.tsx`, `AdminDashboard.tsx`, `DevDashboard.tsx`, `ManagerDashboard.tsx`, `AuthView.tsx`, `CandidateList.tsx`, `JobQueueView.tsx`, `FormRenderer.tsx`, `EditableFormField.tsx`, `SourceBadge.tsx`, `SubmissionControls.tsx`, `ProofViewer.tsx`, `DifficultyBadge.tsx`, `HeaderSignOut.tsx`, `DevSwitcher.tsx`) and legacy HTML shells (`index.html`, `admin.html`, `dev.html`, `manager.html`, `operator-app.jsx`).
- [x] Defined Apple Music token system in `tokens.css` and `dashboard/tailwind.config.cjs`: `#0a0a0a` (page/bg), `#1c1c1e` (surface 1/cards/modals), `#2c2c2e` (surface 2/inputs/borders), `#3a3a3c` (surface 3/glassy pills/borders), `#8e8e93` (low-contrast/metadata text), `#ffffff` (primary text).
- [x] Rethemed status accents (`#30d158` APPLIED/QUEUED/APPLYING/approve, `#ff453a` FAILED/error, `#ff9f0a` OTP/CAPTCHA/SKIPPED/warning), source badges (`#0a84ff` Supabase, `#5ac8fa` AI, `#0071e3` Manual), and difficulty badges (`#30d158` Easy, `#ff9f0a` Medium, `#ff453a` Hard).
- [x] Recompiled Tailwind CSS bundle (`npm run build:dashboard-css`); typechecks (`npm run typecheck`) and production build (`npm run build`) pass cleanly with zero logic changes.

### Profile-Fact Resolution in Tiers 3–4 (2026-10-06)
- [x] Tier 3 semantically compares question embeddings with candidate profile and nested raw-payload fact labels before searching the QA-bank vector index.
- [x] Tier 4 fuzzy-matches profile/raw-payload fact labels before falling back to historical QA-bank answers.
- [x] Kept fact embeddings in process memory; no profile column or database migration is required.
- [x] Updated the parallel resolver worker path to execute semantic Tier 3 and fuzzy Tier 4 consistently.

### Sandbox Candidate Jobs Loading (2026-10-06)
- [x] Bypassed the Zoho-connected-profile gate on candidate/job read endpoints only in sandbox mode so local jobs can load without Zoho setup.
- [x] Kept production reads and all submission routes behind the existing Zoho gate.

### Sandbox DB Viewer Formatting (2026-10-06)
- [x] Prevented wide query results from collapsing the table-list sidebar; results scroll inside their own pane.
- [x] JSON/JSONB cells now default to a compact preview and expand/collapse when clicked.

### Sandbox Scanned-Template Persistence (2026-10-06)
- [x] Kept `exportScannedJobs` on the local PostgreSQL thenable path in sandbox instead of calling Supabase-only `.abortSignal()`.
- [x] Separated scanner errors from export errors so failed scanned-template writes propagate and fail ingestion rather than being logged as a non-fatal scan warning.
- [x] Re-exported the existing 10 scanned templates to the sandbox DB and verified all 10 rows were persisted; `npm run typecheck` passes.

### Role Switcher Persistence & Dev Operator Mode (2026-10-05)
- [x] Persisted role switcher across both TSX and HTML dashboards; dev users can switch freely to Operator mode and return to Dev/Admin/Manager without manual URL editing.
- [x] Operator dashboard (`dashboard/App.tsx`) now renders `<DevSwitcher current="/" />` in the top header for users authenticated as `dev`.
- [x] Maintained `applywizz_dev_operator_view` session flag while browsing the Operator dashboard so page reloads do not bounce dev users to `/dev`.
- [x] Aligned `DevSwitcher` click handlers across `DevSwitcher.tsx`, `dev.html`, `admin.html`, and `manager.html` to set the flag on Operator click and clear it on other role clicks.
- [x] Added `applywizz_dev_operator_view` removal to session logout routines in `useSession.ts` and `roleAccess.js`.

### Resolver Correctness Fixes (2026-10-05)
- [x] Country pre-tier resolution now uses the candidate profile and country aliases; unresolved country fields do not reach Tier 5.
- [x] Tier 5 choices retain their effective options through final alignment, and option-less rich EEOC identity fields no longer receive fabricated Yes/No options.
- [x] Profile URL fallbacks, Tier 4 URL guards, restrictive-covenant consent gating, state extraction, binary degree answers, and education date selects were corrected.
- [x] Added focused resolver regression checks and passed `npm run typecheck`.

### Sandbox Production Parity (2026-10-05)
- [x] Implemented `docker-compose.sandbox.yml` with PostgreSQL 17/pgvector and pgweb for a complete local database matching Supabase.
- [x] Implemented `SandboxQueryBuilder` that maps standard Supabase `.from().select().eq().insert().upsert()` methods to raw local Postgres SQL (with `.not()` support).
- [x] Auto-loads `SANDBOX=true` mode and overrides JWT `requireAuth` to auto-login dev user `yaswanthnaiduyalla@applywizz.ai`.
- [x] Triggers auto-ingestion on `npm run sandbox:fresh` by copying any root CSV to the local Dropzone and bypassing caching pipeline loops.
- [x] Included visual HTML database viewer inside the server at `http://localhost:3001/dev/db` as a fast UI for operators.

### Fast REST API OTP Resolution & Submission Hardening (2026-09-26)
- [x] Implemented `fetchZohoOtpViaApi` in `src/services/zoho-connector.ts` to poll the Zoho connector REST API every 2s for incoming Greenhouse security codes.
- [x] Switched `otpResolutionService.ts` to use REST API as primary resolver, reducing OTP retrieval time from ~30s to 2–5s.
- [x] Completely removed legacy Playwright `zohoReaderPool` and `zohoReader.ts`; OTP resolution and email verification now run 100% via REST API without launching Chromium.
- [x] Operator-approved resolved fields made authoritative truth during submission; forced heuristics relegated to secondary fallbacks if values are empty.
- [x] Regex in `isWorkAuthRelocation` corrected to prevent overriding sponsorship questions; submitter respects "No" resolved choices without forcing "Yes".
- [x] Preserved and enriched options for select/radio/checkbox fields across `answerResolver.ts` and `applicationFieldHydration.ts`.
- [x] Added contextual UI hints and full option selects in `EditableFormField.tsx` and `operator-app.jsx`.
- [x] Implemented 2-phase dropdown resolution (exact first, semantic alias/fuzzy second) in `formFiller.ts` and updated hidden required input selector.
- [x] Fixed headful submission option forwarding in `liveSubmit.ts` and enforced headless in production container mode.

### Stats, retry, and React-Select reliability hardening (2026-09-25)
- [x] Removed automatic submission requeue from the active submitter pool, synchronous submission route, and legacy queue daemon path; failures remain operator-visible `RETRY`.
- [x] Added stale `APPLYING` recovery after a 15-minute worker claim timeout, transitioning abandoned claims to `RETRY` without automatic requeue.
- [x] Added React-Select settle/blur verification and delayed hidden `requiredInput` regression coverage.
- [x] Reworked stats to one non-overlapping daily historical grain, exact range querying, snapshot-before-prune ordering, and full working-table cleanup.
- [x] Added manager/CA-scoped historical metric facts in migration 027; migration validation/application is pending before deployment.

### Canonical Dashboard Application Statistics (2026-10-06)
- [x] Added migration 027 for idempotent daily creation/status-transition facts, event-time global/manager/CA ownership, and an explicit availability cutover without legacy backfill.
- [x] Unified Admin/Dev, Manager dashboard/operators/reports/overview/stats, and `/api/stats` around Total, Submitted, Applied, and Failed definitions; preserved team/CA scoping and explicit partial/unavailable range states.
- [x] Changed `db:fix-rollup` to inspect canonical yesterday/today facts read-only; ingestion pruning remains guarded by migration 027.
- [x] Added focused contract/scope/cutover/operator-attribution tests; `npm run typecheck` and `npm run build` pass.
- [x] Applied migration 027 in the connected Supabase project and verified both stats tables, the `available_from` value (`2026-10-08`), and the capture trigger via SQL on 2026-10-07.

_Last updated: 2026-10-07_

### Same-day application stats and score-independent submissions (2026-10-07)
- [x] Fixed fresh stats installs to begin availability on the current IST day, and added migration 028 to move an existing future cutover to the earliest day with recorded facts (or today when no facts exist).
- [x] Kept pre-trigger history explicitly unavailable; production must apply migration 028 before current-day captured facts appear.
- [x] Removed the submission score gate, its Dev UI/API/runtime toggle, and its environment flag. All scores are accepted; the existing 35-question submission cap is unchanged.
- [x] Added regression coverage that low and missing CSV scores do not block, while the field-count boundary remains enforced.

### Form Submission Reliability Fixes (2026-09-23)
- [x] Re-attempted initially failed fields that become visible after cascade expansion, while leaving still-hidden fields failed.
- [x] Replaced millisecond timestamps in retry `submission_order` payloads with bounded retry counts.
- [x] Added DOM value assignment for `input[type="number"]` and explicit date-year aria-label selectors.

### Profile Backfill Utility (2026-09-23)
- [x] Added `npm run backfill:profiles` to refresh every Supabase profile from ApplyWizz in concurrent batches of 10.
- [x] Added progress and completion counters plus `scripts/backfill_failed.json` output for failed IDs.

### Choice Resolution and React Dropdown Reliability (2026-09-23)
- [x] Added shared fail-closed semantic option alignment for pre-tier, structured, and Tier 5 choice answers.
- [x] Added canonical aliases for work authorization, country, race/ethnicity, gender, veteran, disability, and yes/no prose.
- [x] Hardened searchable Greenhouse controls to click live options, verify committed state, and retry once when a click does not commit.
- [x] Added regression coverage for semantic mappings, ambiguity rejection, and Greenhouse searchable-select fixtures.

### OTP Retry and Submission Question-Limit Failure UI (2026-09-23; score gate removed 2026-10-07)
- [x] Requeued OTP-fetch failures returned as `OTP_REQUIRED` through the submitter pool and accepted `OTP_REQUIRED` in the guarded retry transition.
- [x] Prevented double incrementing of `retry_count` by making the queue retry owner apply the increment once per attempt.
- [x] Added authoritative submission-block metadata to application DTOs and job rows; it now identifies only question-limit blocks.
- [x] Limited the requirements panel to question-limit failures and exposed retry for ordinary failed applications.
- [x] Added `[OTP TRACE]` and question-limit logs for production verification of retry and submission decisions.

## ✅ Fully Shipped (V2 — Production on Railway)

### Responsive TSX Operator Mobile Flow (2026-10-07)
- [x] Added a mobile-only candidates → jobs → application screen flow at ≤768px with back navigation that preserves the selected candidate and job.
- [x] Mobile candidate cards show only name and job count; the job queue becomes a scrollable application list, and application review keeps the carousel/full-list toggle with a fixed Dry-Run and Approve & Submit bar.
- [x] Preserved the desktop split-pane and left all legacy dashboards untouched.
- [x] Verified `npm run typecheck:dashboard`, `npm run build:dashboard`, and `git diff --check`.

### Missing Choice Option Capture (2026-10-06)
- [x] Enriched Remix fields missing choice values from visible native selects, radio groups, and custom Greenhouse dropdowns opened through Playwright pointer interaction (including portaled menus).
- [x] Re-ran enrichment during cascade exploration so initially hidden choice fields are captured when revealed; extraction does not select a value.
- [x] Added browser-backed regression tests for mousedown-only EEOC-style custom selects, portaled options, native selects, conditional visibility, and preserving existing Remix options.
- [x] User confirmed a fresh sandbox scan now persists options for Country, School, Degree, Gender, transgender, ethnicity, Race, Veteran Status, and Disability Status.

### Incomplete Required Choice Handling (2026-10-06)
- [x] Marked native/Remix choice lists complete and detected scrollable/virtualized custom menus as partial without exhaustive scrolling.
- [x] Propagated completeness through resolver, LLM, application hydration, and operator API payloads; partial options no longer constrain answer selection.
- [x] Required incomplete selects render as text entry with an exact-choice hint while retaining `type: "select"`.
- [x] Confirmed live submission selects and verifies an actual Greenhouse option and fails closed when no live option matches.
- [x] Passed focused browser/resolver tests, `npm run typecheck`, and `npm run build`.

### Direct Admin CSV Upload (2026-10-06)
- [x] Added Admin/dev-only CSV upload to the production TSX Admin dashboard, with supported-header validation, a 25 MiB cap, and upload progress.
- [x] Staged uploads under `csv_uploads/pending/` and required confirmation before triggering ingestion for the exact object; missing targets fail without falling back to another CSV.
- [x] Preserved the existing latest-pending Start flow and legacy dashboard; `npm run build` and focused CSV upload validation tests pass.

### Dashboard Visual Restyling & Active Tab Text Fix (2026-09-25)
- [x] Fixed active dashboard tab text turning white when selected: changed to explicit `text-black` across `dashboard/App.tsx`, `DevDashboard.tsx`, `ManagerDashboard.tsx`, `AdminDashboard.tsx`, and `AuthView.tsx`.
- [x] Added explicit `nav button, nav button.bg-[#E88474], nav .active, header nav button { color: #000000 !important; }` in `tokens.css` to prevent button color overrides.
- [x] Removed ALL box shadows across the dashboard: stripped every `shadow-[...]`, `shadow-sm`, `shadow-md`, `shadow-lg`, and `drop-shadow-*` class across all dashboard components.
- [x] Removed `--color-shadow` token from `tokens.css` and replaced card shadows with subtle `border: 1px solid #f3f4f6 !important;` (`border-gray-100`).
- [x] Added global shadow reset in `tokens.css`: `*, *::before, *::after { box-shadow: none !important; --tw-shadow: 0 0 #0000 !important; --tw-shadow-colored: 0 0 #0000 !important; }`.
- [x] Rebuilt dashboard CSS bundle via `npm run build:dashboard-css` and verified full build and typecheck pass cleanly.

### Dev Debugger Enhancements (2026-09-23)
- [x] Sourced and hydrated `proof_failed_url` in dev dashboard debugger endpoint (`/api/dev/applications/:id`).
- [x] Rendered `Failed screenshot: View` link in `DevDashboard.tsx` and `dev.html` after web/email proof links.
- [x] Sourced `manager_email` from `gh_users` for assigned operator email and rendered in Debugger view.
- [x] Queried `gh_application_events` chronologically (`ORDER BY created_at ASC`) and rendered formatted timeline with IST timestamps: `"{created_at IST} — {previous_status} → {new_status} (by {actor_email})"`.
- [x] Kept existing empty timeline fallback when no events exist.

### Manager Home & Operators Metrics Unification (2026-09-23)
- [x] Unified Manager Home and Operators tabs to display the identical three metrics: Total (all non-SKIPPED applications), Submitted (`status != 'READY_FOR_REVIEW'`), Applied (`status = 'APPLIED'`, using `submitted_at`).
- [x] Sourced all 3 metrics on both tabs from the single `/api/manager/dashboard` response without separate count queries.
- [x] Removed separate rollup query overrides in `/api/manager/dashboard` and `/api/manager/operators`.
- [x] Maintained full parity across `dashboard/components/ManagerDashboard.tsx` and `dashboard/public/manager.html`.

### Stats Rollup System (2026-09-23)
- [x] Implemented database migration `024_stats_rollups` to securely store `total_applications`, `submitted_count`, `applied_count`, and `failed_count`.
- [x] Created `runStatsRollup` service that safely calculates daily, weekly, and monthly metric aggregations using IST date boundaries, while strictly pruning old ingest rows to ensure database speed.
- [x] Automatically wired rollup trigger prior to Phase A of the storage ingestion pipeline.
- [x] Refactored Admin `/api/admin/overview`, Manager `/api/manager/dashboard`, and unified `/api/stats` to source root analytics reliably from `queryRollupStats`.

### Answer Resolution Quality Fixes (2026-09-23)
- [x] Added pre-tier rule to detect consent/acknowledgment fields before Tier 1 matching, automatically answering them with the affirmative option (or "Yes").
- [x] Added try/catch block to `synthesizeBatchAnswers` to prevent LLM parse errors from crashing the batch, instead gracefully returning unresolved.
- [x] Improved `cleanLLMOutput` to strip markdown fences using a more resilient non-anchored regex.
- [x] Added 4th option matching fallback (prefix matching) for when LLM answer is a prefix of an option.
- [x] Upgraded LLM prompts for both single and batch synthesis to strictly enforce exact option matching and forbid markdown output.

### Structured Payload Resolution Context (2026-09-23)
- [x] Added deterministic T1 resolution from the stable `client` and `additional_information` payload objects, including boolean and date formatting.
- [x] Replaced Tier 5 batch raw payload serialization with a bounded structured candidate context.

### OTP retry budget hardening (2026-09-22)
- [x] OTP fetch failures now remain `OTP_REQUIRED` through the bounded retry budget before becoming `FAILED`.
- [x] Zoho OTP-fetch failures preserve `EMAIL_PROOF_PENDING` and `APPLIED` when a confirmed-submission status has already been persisted.
- [x] Retry counts are normalized to integer values in the 0–3 range; timestamp-like corrupted values no longer bypass or exhaust the retry budget incorrectly.
- [x] Zoho OTP lookup scans 20 messages across a 15-minute window.

### Resume pre-submit availability guard (2026-09-22)
- [x] Required resume fields are checked before form filling; missing storage objects are re-downloaded from ApplyWizz and re-uploaded.
- [x] Submission fails before browser form submission when the resume cannot be recovered.

### EEOC custom-select option matching (2026-09-22)
- [x] Searchable selects now try case-insensitive contains matching after exact matching.
- [x] Common short EEOC race answers are normalized to Greenhouse variants such as `Asian (not Hispanic or Latino)`.

### Hidden required-input detection (2026-09-22)
- [x] Scanner and cascade detection now recognize Greenhouse hidden `required_*` and `input.hidden[value="true"]` validation inputs near a field wrapper.

### Required-field pre-submit gate (2026-09-22)
- [x] Live submission now fails before clicking submit when a required field is empty or unresolved, listing the affected labels in `error_message`.
- [x] Required fields without a resolved value are reported as failed by `formFiller.ts` instead of silently succeeding.

### Dashboard Stats Range Unification (2026-09-22)
- [x] Added shared IST day/week/month stats-range parsing with day as the default.
- [x] Scoped admin overview, dev health, manager reports, and operator `/api/stats` to the selected period.
- [x] Replaced manager’s 14/56/180-day report meanings with calendar day/week/month periods.
- [x] Added Day / Week / Month selectors to the Admin, Dev, and Manager dashboard stats surfaces.
- [x] Preserved live queue/worker health as operational snapshots rather than silently mixing it into period statistics.

### Answer Resolver Logging Standardization (2026-09-22)
- [x] **Standardized Per-Field Resolution Log Format (`answerResolver.ts`):** Unified all per-field logging across Tiers 1–5 in both single-field (`resolveField`) and batch (`resolveJobApplication` / `resolveFieldThroughTier2` / `resolveTier5Batch`) execution paths:
  - Success: `[Resolver] ✅ T{tier} {question_label} → "{answer}"`
  - Failure: `[Resolver] ❌ T{tier} {question_label} — {reason}`
  - Standardized reasons: `no profile match` (T1), `no resume match` (T2), `below similarity threshold ({score})` (T3), `no fuzzy match` (T4), `LLM parse error` (T5), `no option match` (T5), `unresolved` (T5).
- [x] **Stripped Redundant Telemetry & Per-Field Noise:** Removed legacy bullet previews (`• [Source] "label" ➔ "preview"`), verbose tier telemetry, raw payload mining logs, and cascade noise across `answerResolver.ts`, `tier1Supabase.ts`, `semanticSearch.ts`, `tier5LLM.ts`, and `llmSynthesizer.ts`. Preserved pipeline-level summary and progress logs.
- [x] **Exposed Last Semantic Score (`semanticSearch.ts`):** Added `getLastSemanticScore()` tracking top candidate score even when below threshold (`match_threshold: 0.0` RPC probe) for accurate failure log scores.

### Proof Image Rendering & Viewer Resilience (2026-09-21)
- [x] **Proof URL access:** List and dashboard responses return raw storage paths; explicit proof viewer/retrieval routes generate signed URLs on demand.
- [x] **Dual-Lookup & Resilient Proof URL Renewal:** Updated `GET /api/applications/:id/proof-url` and `GET /api/applications/:id/proof` to support UUID and candidate ApplyWizz ID + `jobUrl` composite lookup.
- [x] **Server-Side Streaming Proxy (`/api/applications/:id/proof-image`):** Added a first-party binary image streaming proxy with service-role access that bypasses external storage token expiration and CORS restrictions.
- [x] **Multi-Stage Progressive Fallback in ProofViewer:** Updated `dashboard/components/ProofViewer.tsx` and `dashboard/public/operator-app.jsx` with progressive fallback (`initial signed URL` → `refreshed signed URL` → `proxy stream`) and passed `applicationId` and `kind` across `FormRenderer`, `SubmissionControls`, and `JobQueueView`. Eliminated infinite retry loops.

### Stat & Flow Inconsistencies Fixes (P0, P1, P2 — 2026-09-21)
- [x] **P0-1 (Ownership check NULL-safe & case-insensitive):** Ownership checks across `applications.ts` and `submissions.ts` allow submission when `assigned_ca_email` is NULL or undefined (open pool), and perform case-insensitive normalized email comparison.
- [x] **P0-2 (HTTP 403 user-facing error & status safety):** FormRenderer displays visible error banner on 403 ("Access denied — this application is not assigned to you") and prevents local status from transitioning to `QUEUED`.
- [x] **P0-3 (DRY_RUN_COMPLETE submission actions):** Removed `DRY_RUN_COMPLETE` from `hideSubmissionActions` and included it in `canSubmit`, allowing operators to approve and submit directly after dry-run completes.
- [x] **P0-4 (Internal worker authentication):** Added `INTERNAL_API_SECRET` to environment validation and `.env.example`, enforced constant-time secret check middleware on `/api/internal/*`, and sent `x-internal-secret` on worker proxy and internal WebSocket broadcasts.
- [x] **P0-5 (OTP_REQUIRED & CAPTCHA_REQUIRED UI separation):** Dedicated badge status and rendering in `operator-app.jsx` (stopped remapping to `APPLYING`). Added OTP code input + submission and CAPTCHA browser resume actions.
- [x] **P1-1 (Eliminated `completed` in favor of canonical metrics):** Standardized canonical definitions across all backend routes and frontend dashboards: `submitted = status != 'READY_FOR_REVIEW'`, `pending = status = 'READY_FOR_REVIEW'`, `applied = status = 'APPLIED'`, `failed = status IN ('FAILED', 'CAPTCHA_TIMEOUT')`. Replaced all UI labels "Completed" with "Submitted".
- [x] **P1-2 (Correct timestamp columns):** `applied` counts use `submitted_at` instead of `updated_at`; manager dashboard date range query parameters (`parsedRange.startIso`, `parsedRange.endIso`) are strictly honored in dashboard stats and reports.
- [x] **P1-3 (Dev health applied date-scoping):** Dev dashboard applied metric is scoped to requested date range using `submitted_at`.
- [x] **P1-4 (Divide-by-zero guards):** Admin dashboard percentages (`supabasePercent`, `aiPercent`, `resumePercent`) guarded with ternary checks against zero denominators.
- [x] **P2-1 (EMAIL_PROOF_PENDING UI state):** Dedicated UI badge, "Waiting for email proof" status indicator, and "Get email screenshot" action button.
- [x] **P2-2 (Status-specific error messages in blocked panel):** Added actionable descriptions and buttons for `SKIPPED`, `EXPIRED`, `CAPTCHA_TIMEOUT`, `OTP_REQUIRED`, and `CAPTCHA_REQUIRED`.
- [x] **P2-3 (Database cleanup):** Executed SQL cleanup on remote Supabase instance updating non-Greenhouse URLs to `SKIPPED` with `error_message = 'Non-Greenhouse job URL'`. Verified 3 rows updated and 1 demo localhost row preserved.

### CA Email Pipeline Step & Live Backfill (2026-09-21)
- [x] Implemented `fetchCaEmailForApplywizzId` and `fetchCaBatchEmailMap` in `src/candidate/applywizzClient.ts` querying the CA Management work-history API to resolve `careerassociateid` to `ca_email`.
- [x] Added `upsertProfileCaEmail` in `src/db/profiles.ts` to update `profiles.ca_email`.
- [x] Added Phase B.5 in `src/orchestrator/pipeline.ts` and updated phase regex in `src/scanner/storageCsvIngestion.ts`.
- [x] Injected `assigned_ca_email` in `src/resolver/answerResolver.ts` and cached lookup in `src/db/applications.ts` `upsertApplication`.
- [x] Updated `GET /api/admin/applications` in `src/server/routes/adminDashboard.ts` with left join on `profiles` and display fallback for `assigned_ca_email`.
- [x] Executed live backfill on remote database: 294 profiles populated with `ca_email`, 876/876 applications populated with `assigned_ca_email`.

### TSX Port of Admin, Dev & Manager Dashboards (2026-09-21)
- [x] Ported `dashboard/public/admin.html` to `dashboard/components/AdminDashboard.tsx` with full tab parity (Overview Ingest Bar, Managers, Operators, Applications, Activity, System, Guide) and modals (`EmailProofModal`, `ApplicationProofModal`).
- [x] Ported `dashboard/public/dev.html` to `dashboard/components/DevDashboard.tsx` with full tab parity (System with Submission Eligibility Gate toggle, Runs, Errors, Queue, Integrations, Debugger, Guide).
- [x] Ported `dashboard/public/manager.html` to `dashboard/components/ManagerDashboard.tsx` with full tab parity (Home with CA filter, Operators, Activity, Reports with period buckets & Applied modal, Guide, Dev Ops Mode picker).
- [x] Shared navigation & session components: `DevSwitcher.tsx` and `HeaderSignOut.tsx`.
- [x] Hook-based authentication via `useRequireRole` in `useSession.ts` with clean `useEffect` redirect to role home.
- [x] Vite multi-entry build (`vite.config.ts`) emitting `index.html`, `admin/index.html`, `dev/index.html`, `manager/index.html` to `dist/client/`.
- [x] Server routes in `src/server/index.ts`: `/admin`, `/dev`, `/manager` served from `dist/client/*/index.html` when `DASHBOARD_MODE=tsx`, with legacy fallbacks at `/admin/fallback`, `/dev/fallback`, `/manager/fallback`.

### Security, Reliability & Performance Hardening (2026-09-21)
- [x] SEC-1 & SEC-2 — Auth bypass gated strictly to `NODE_ENV === 'test'` with real test token validation; `x-user-role` header fallback removed (`requireRole.ts`)
- [x] SEC-3 — Strict IDOR ownership validation on application update and approve routes (`applications.ts`)
- [x] SEC-4 — SSRF URL protocol and host whitelist validation prior to Playwright navigation (`liveSubmit.ts`)
- [x] RACE-1 — Atomic queue worker TOCTOU claim check via `.select('id')` validation (`queueWorker.ts`)
- [x] RACE-3 — Proof capture failure isolation preserving `APPLIED` status (`liveSubmit.ts`)
- [x] PERF-1 — 5MB PDF file size guard before reading resumes (`tier2ResumeParse.ts`)
- [x] PERF-2 — Per-URL page lifecycle recreation avoiding browser memory accumulation (`playwrightScanner.ts`)
- [x] SEC-5 — Safe default fallback for `JWT_SECRET` in Zod env validation (`env.ts`) with production warning log to prevent unhandled boot crash-loops on Railway
- [x] SEC-8 — Restricted CORS origins via `ALLOWED_ORIGINS` whitelist (`server/index.ts`)
- [x] RELIABILITY-1 — 30-minute auto-close TTL for paused CAPTCHA/OTP browser sessions (`captchaResume.ts`, `liveSubmit.ts`)
- [x] RELIABILITY-2 — LLM error classification (retriable vs permanent) and typed failure bubble in Tier 5 (`tier5LLM.ts`)
- [x] PERF-3 — Database query pushdown for unconstrained status/date application queries (`manager.ts`, `devDashboard.ts`)
- [x] PERF-4 — Adaptive dashboard polling interval: 30s connected, 3s on disconnect (`App.tsx`, `operator-app.jsx`)
- [x] PERF-5 — LRUCache capped at 5000 entries for semantic search embeddings (`semanticSearch.ts`)
- [x] SEC-6 — Eliminated `dangerouslySetInnerHTML` for MFA QR SVG in favor of sandboxed `<img>` data URIs (`AuthView.tsx`, `index.html`)
- [x] SEC-9 — Migrated token persistence from `localStorage` to `sessionStorage` (`roleAccess.js`)
- [x] SEC-10 — Content Security Policy `<meta>` tags on all public HTML shells (`index.html`, `manager.html`, `admin.html`, `dev.html`)
- [x] QUALITY-1 — Masked internal server errors in 500 HTTP responses with generic messages (`applications.ts`, `submissions.ts`)

### Infrastructure & CI/CD
- [x] GitHub Actions CI pipeline (`.github/workflows/ci.yml`) — triggers on `main`, `feature/**`, `fix/**`, `hotfix/**`, `patch/**`, and PRs with `typecheck` → `build` → non-blocking `test` waterfall, automated PR failure comments, and status badge
- [x] Multi-service isolation — Zoho Reader background session initialization restricted to worker service via `ENABLE_QUEUE_WORKER === 'true'` (web/ingest services skip launch cleanly)
- [x] Dev Operator View navigation — `applywizz_dev_operator_view` session key signaling in `dev.html` DevSwitcher and `App.tsx` mount guard

### Core Pipeline
- [x] CSV ingestion + URL normalization + deduplication (`csvDeduplicator.ts`)
- [x] Playwright headless form scanner — extracts all Greenhouse field types (`playwrightScanner.ts`)
- [x] Expired/404 job detection
- [x] ApplyWizz API client — profile sync + resume PDF download (`applywizzClient.ts`)
- [x] Candidate segregation by AWL ID (`segregator.ts`)
- [x] Resume PDF upload to Supabase Storage (`db/storage.ts`)

### 5-Tier Answer Resolver
- [x] Tier 1 — Supabase profiles + qa_bank direct lookup (`tier1Supabase.ts`)
- [x] Tier 2 — pdf-parse resume extraction with caching (`tier2ResumeParse.ts`)
- [x] Tier 3 — Semantic vector search via OpenRouter embeddings + pgvector (`semanticSearch.ts`, 2026-09-19)
- [x] Tier 4 — Fuse.js fuzzy match on qa_bank (`tier3FuzzyMatch.ts`)
- [x] Tier 5 — Multi-provider LLM synthesis with qa_bank write-back and embedding indexing (`tier5LLM.ts`, `llmSynthesizer.ts`, `semanticSearch.ts`, 2026-09-19)
- [x] Question fingerprinting via SHA-256 (`fingerprint.ts`)
- [x] Answer source tagging: `supabase`, `ai`, `manual`, `unresolved`

### Database
- [x] Full Supabase schema: 5 core tables + storage buckets
- [x] 16 files in `src/db/migrations/` (001–015 + `latest_supabase_migration.sql`). **015** (`audit_events` / `application_events` + service_role RLS) **operator applied 2026-09-15**. **014 (`SKIPPED`) may still need apply**. **013 (`EMAIL_UNVERIFIED`)** operator reported applied
- [x] Idempotent upsert patterns throughout
- [x] V1 → V2 migration runner (`db/migrate.ts`)

### Submission Engine
- [x] Form filler — maps resolved fields to DOM selectors (`formFiller.ts`, 59KB)
- [x] Dry-run (headful fill, screenshot, no submit) (`dryRun.ts`)
- [x] Live submission (headless fill → submit → proof) (`liveSubmit.ts`, 69KB)
- [x] CAPTCHA / OTP detection — pauses for operator manual solve
- [x] Cascade / conditional field detector (`cascadeDetector.ts`)
- [x] Web proof capture — screenshot on confirmation → Supabase Storage (`proofCapture.ts`)
- [x] Queue worker + submission pool (`queueWorker.ts`, `submitterPool.ts`)

### Operator Dashboard
- [x] Express REST API (auth, applications, submissions, manager, notifications routes)
- [x] WebSocket real-time status push (`ws.ts`)
- [x] JWT-based auth (`routes/auth.ts`)
- [x] Operator can edit any field inline → saved as `manual` source to qa_bank
- [x] Dry-run / Approve & Submit / View Proof controls in dashboard

### V2.5 Dashboard & Ops (This Release)
- [x] Manager `GET /api/manager/dashboard` — expandable completed/pending/failed details; date + CA filters. **Team scoping on** via `users.manager_email` → operator `assigned_ca_email` (`MANAGER_TEAM_SCOPE_ENABLED = true`, 2026-09-16)
- [x] **Dashboard default date range** — stats/lists default to today + yesterday (IST); optional `?from=&to=`; UI label "Today & Yesterday" (2026-09-16)
- [x] **Operator queue UX** — show SKIPPED / pre-resolve rows; unresolved + skipped badges; blocked form panel + operator-friendly `error_message` copy (2026-09-16)
- [x] **Operator → manager mapping on login** — upsert `users`, set `manager_email` from work-history CA manager UUID map; migration **017** (2026-09-16)
- [x] **Resolve-time-only `candidate_applications` upserts** — removed segregator / post-scan placeholder upserts; skip when no non-empty resolved values; SKIPPED over-cap at resolve; idempotent preserve of existing fields in `upsertApplication` (2026-09-16)
- [x] **Railway crash-loop fix** — `ERR_INVALID_CHAR` on `X-Dashboard-Date-Range` (en-dash in custom date label); `httpHeaders.ts` + ASCII label in `dashboardDateRange.ts` (2026-09-16)
- [x] **Manager list API scoping** — `GET /api/candidates`, `/jobs`, `/stats`, `GET /api/users` team-filtered for managers; dev/admin unrestricted (2026-09-16)
- [x] Manager UI at **`/manager`** (managers + dev). Secondary tabs: Operators, Activity, Reports (volume only); the 30s poll also refreshes Activity while that tab is open (2026-09-18)
- [x] **Manager reports API per-operator metrics** — `GET /api/manager/reports` `perOperator[]` returns period-scoped `apps` / Assigned and `completed` metrics. The reports tab per-operator table renders **Assigned / Completed / Applied**: the API's `approved` field is intentionally no longer rendered (column removed 2026-09-18), and **Applied** is a clickable count that opens a modal of that operator's applied jobs (job title + company + web/email proof links, `AppliedModal` in `manager.html`). Applied data is composed client-side from `GET /api/manager/dashboard` APPLIED details (proof URLs hydrated server-side) over the reports window (daily=14d / weekly=56d / monthly=180d) because `/reports` returns no applied job data (2026-09-18)
- [x] **Manager metrics synchronization** — Operators Assigned/Completed/Applied now use the same scoped/date-filtered rollup as Home; API failures are shown instead of leaving zero defaults; Activity filters by the selected date range; Reports Assigned counts are period-scoped (2026-09-21)
- [x] **Worker/ingest split dashboard and operator flow fixes** — `/api/stats` uses the selected range for Supabase-backed outcome counts; operators can edit answers regardless of assignment ownership; submission assignment checks normalize email casing; retryable failed/dry-run/email-proof-pending statuses no longer show the generic blocked panel (2026-09-21)
- [x] Admin dashboard at **`/admin`** — org overview, managers, operators, applications, audit, system status, **▶ Start** ingest; the Overview ingest status bar is the dashboard's single Start/Stop location and carries ids `ingestStatusBar` / `ingestStatusText` / `ingestStartBtn` / `ingestStopBtn` (2026-09-18)
- [x] Dev dashboard at **`/dev`** — health, runs, errors, queue, integrations, application debugger
- [x] Login redirects by role (`homePath`); strict API isolation (`requireRole`)
- [x] Auth audit logging + `POST /api/auth/logout`
- [x] Bundled **AWL-31428** demo restored (`akshithaDemoFixtures.ts`); optional override via `npm run demo:fixture-31428`
- [x] Admin demo job queue merges Supabase + artifact jobs (fixes 1-of-4 queue for Akshitha when DB has partial rows)
- [x] CSV ingest: `lead_name`, `company_job_url` / `job_url` column aliases
- [x] Form filler: Greenhouse **remix-css** `select_input-container` / `role="combobox"` + fuzzy option match; `tests/searchableSelect.test.ts`
- [x] React-Select sponsorship combobox hardening (AWL-31428 Prometheus `question_32545342003`): field-scoped option click, flyout toggle fallback, verify `.select__single-value`; **no Enter-on-failure** (clears filter on Greenhouse boards)
- [x] Headful demo CLI: `npm run dry-run -- --candidate=AWL-31428 --maxJobs=1` → Prometheus U.S. sponsorship job; screenshot `output/awl31428_prometheus_dryrun.png`
- [x] Operator dashboard: job cards expand/collapse for review only (no auto-select first job; clear form on collapse; no optimistic `QUEUED` on submit click)
- [x] Removed stale one-off tests; `npm test` → `e2eIntegration.test.ts`
- [x] **Duplicate-submission guards** — `IN_FLIGHT_STATUSES` check before the `APPLYING → QUEUED` rewrite in `PATCH /:id/status`, `inFlightApplicationIds` in `SubmitterPool`, and a `persist` flag on the dashboard's `handleStatusChange` so the 2s poll refreshes the display without writing back (see Known Bugs for the failure it fixes)
- [x] **Dashboard `.tsx` tree typechecks clean and stays that way** — 35 pre-existing errors fixed, `dashboard/tsconfig.json` added at root-equivalent strictness, and `npm run typecheck` chained to `npm run typecheck:dashboard`
- [x] **Admin ▶ Start button for CSV ingestion** — `POST /api/admin/trigger-ingest-from-storage` is admin-gated (`403` for non-admins, `409` while a run is in flight) and returns `202` with the pipeline running in the background; `GET /api/admin/ingest-status` reports `{running, processedFile, message, error}`. The **▶ Start** control is on `/admin`, not the operator header
- [x] **Zoho OTP reader hardened** — verbose step-by-step logging across `zohoReader.ts` (navigation/login status, session cookies, search query, raw message list, per-email sender/subject/timestamp, active regex) and `zoho-connector.ts` (request URL, HTTP status, raw body before parsing, parsed message summary). New `isGreenhouseOtpEmail()` sender+subject+company gate runs before extraction; scan 3 → 15 rows; 10-min window; `parseZohoEmailTimestamp` unified with the confirmation path; `reason` field on failure. Verified live against AWL-31428 → `NgW4NT62`
- [x] **Zoho OTP session reset** (`601d37d`) — `resetUiBeforeLookup` goto root + clear filter before each search; 0 user rows → one `page.reload()` retry
- [x] **Zoho OTP step logs** (`8a44cf2`) — numbered `[Zoho] Step 1`–`8` + extra 5s user-list wait; dropped candidates `totalJobs` debug log
- [x] **Operator dashboard title/favicon** (`b8b0276`, logo in `2d268a3`) — title "Apply Wizz"; square AW `/logo.webp` (replaces wide `/full_logo.webp`)
- [x] **Unified email proof pending status** — migration 022 normalizes legacy `EMAIL_UNVERIFIED` rows; poller retains `EMAIL_PROOF_PENDING` after 10m timeout with `manual_review_needed`, keeping manual email screenshot capture available
- [x] **Supabase ingest credential resolution** — `supabaseKeyDiagnostics.ts`; prefer `service_role` JWT else `SUPABASE_SERVICE_ROLE_KEY` (incl. `sb_secret_`); normalize quoted/Bearer keys; ingest probes every key (`0d02593`); `GET /api/admin/supabase-storage-health` → `keyProbes`
- [x] **Submission requeue hardening** — `EMAIL_PROOF_PENDING` in `IN_FLIGHT_STATUSES`; ignore PATCH `QUEUED` while in-flight; submit-response `persist: false`
- [x] **Question cap 35 + `SKIPPED`** — `MAX_JOB_QUESTIONS` default 35; over-cap jobs upsert `SKIPPED` (migration 014); operator queue **shows** SKIPPED with badge (2026-09-16)
- [x] **Form hydration from `fields_schema`** — empty `resolved_fields` filled from scanned templates (`applicationFieldHydration.ts`)
- [x] **Tier 5 fail-closed + SMS skip** — LLM option mismatch / low confidence → `unresolved`; SMS/marketing opt-in always No at fill (`31b830e`)
- [x] **Role from `users.role` on sign-in** — map override → DB role → operator; JWT + signup gate for existing `users` row (2026-09-16)
- [x] **Manager Ops mode (view-as operator)** — `X-View-As: operator` + dev `X-View-As-Manager-Email`; `/manager` **Ops mode** button (manager confirm, dev manager picker); operator banner **Back to manager mode**; `requireOperatorDashboardAccess` (2026-09-16)
- [x] **Operator/Ops dashboard job queue scope** — `resolveDashboardCandidateAccess`; `dateQuery` on detail and `GET .../jobs/*`; CA + `created_at` scoped list aggregates; dev-only Supabase count overlay (`5b70d04`, 2026-09-17)
- [x] **Dashboard role + candidate list fixes** — `resolveRoleFromRequest` uses `resolveEffectiveAppRole` (email map beats stale JWT operator); manager team scope merges profile IDs; dev/admin `GET /api/candidates` supplements from DB date range; Zoho connected filter skipped for unrestricted roles (`3b42135`, 2026-09-17)
- [x] **Parallel ingest resolve + batched Tier 5 + admin stop** — `RESOLVER_WORKER_POOL_SIZE` (default 3); Tier 5 chunks of 15 with `finalizeRawAnswer`; stop enabled on Railway; admin ingest-status on all tabs (`56d5270`, 2026-09-17)
- [x] **Admin operators by manager** — `GET /api/admin/operators?manager=` uses `users.manager_email`; `managerEmail` on operator rows (2026-09-16)
- [x] **Submission question limit** — ingest all CSV scores; resolve all templates; keep the 35-question cap at resolve/submit. The formerly shipped 20–60 score gate and Dev toggle were removed on 2026-10-07.
- [x] **Operator completion toast** — when a selected candidate's `READY_FOR_REVIEW` / `APPROVED` job count transitions to zero, show a dismissible five-second toast once per candidate per session (2026-09-17)
- [x] **Unresolved-field helper hints** — context-aware inline guidance appears below unresolved answer inputs and hides on focus or typing (2026-09-17)
- [x] **Operator-triggered retry** — retryable OTP/security-code/unresolved-required failures can be manually requeued from the operator dashboard; non-retryable failures remain terminal (2026-09-17)

- [x] **Central logger** — `src/utils/logger.ts`; all `src/` `console.log`/`warn`/`error` → `createLogger`; `[ISO] [LEVEL] [MODULE] message`
- [x] **AW app logo** — `dashboard/public/logo.webp` as favicon + header/auth/manager mark; `express.static(dashboard/public)` so `/logo.webp` is not swallowed by the HTML catch-all
- [x] **Dev ApplyWizz health ping** (`7f91c59`) — `get-client-details` without an id returns HTTP 400; that counts as reachable. Timeouts / 5xx still error

### Beyond-V2-Docs Features (Already Shipped)
- [x] Zoho Mail OTP auto-extraction (`zohoReader.ts`, `zoho-connector.ts`) — was V3 in docs
- [x] `APPROVED` application status (migration 012) — operator approval gate
- [x] Supabase Realtime subscriptions on `candidate_applications` (migration 010)
- [x] Round-robin queue for load-balanced submissions (migration 005)
- [x] Email proof status + JSON storage (migrations 006, 008)
- [x] `zoho_connected_profiles` table (migration 011)
- [x] Azure / MS365 email sending (`azureEmail.ts`)
- [x] `OTP_REQUIRED` status (renamed from `CAPTCHA_REQUIRED`, migration 002)

---

## 🚧 In Progress

| Item | Status | Notes |
|---|---|---|
| **Admin managers + operator workload (API + HTML)** | Implemented locally, uncommitted | `adminManagerStats.ts`, workload count in `applications.ts`, admin/manager route wiring; `admin.html` / `manager.html` display-only PARALLEL fields (2026-09-16) |
| **Zoho connection check during candidate ingestion** | Implemented locally, uncommitted | Shared candidate sync checks one connector snapshot, persists `profiles.zoho_connected`, falls back to stored flags on connector failure, and skips disconnected candidates; sandbox bypass retained (2026-10-06) |
| **Operator dashboard resolution metrics** | Implemented locally, uncommitted | Removed Supabase/AI percentage pills and Stats-tab cards from the TSX operator dashboard only; shared API and legacy UI unchanged (2026-10-06) |
| **Canonical application statistics** | Implemented locally; migration pending | Migration 027 and shared service unify application metric APIs and dashboard surfaces; apply/validate migration before deploying (2026-10-06) |

---

## ⏳ Pending / V3 Scope

| Item | Notes |
|---|---|
| CAPTCHA automated bypass | CapSolver/2Captcha; explicitly out of scope for now |
| Multi-tenant RLS on core tables | Core tables still `USING (true)`. `audit_events` / `application_events` have service_role-only RLS (015 applied 2026-09-15). App-level role dashboards shipped |
| Supabase Storage bucket access policies | Deferred with core-table RLS |
| Residential proxy pool | Anti-bot detection hardening |
| Lift question cap beyond 35 | `MAX_JOB_QUESTIONS` default is 35; further lift needs explicit instruction |
| Resolution engine — Tier 2/3 quality | Optional future | Semantic search / better fuzzy or resume matching; 5-tier prod baseline unchanged |
| **Dashboard UI → bundled TSX (Vite multi-entry)** | Planned, not started | Prod = `dashboard/public` HTML + `operator-app.jsx`; `App.tsx` / components typecheck only. End state: one TS source, pre-built JS per role (`/`, `/manager`, `/admin`, `/dev`); port admin/dev from HTML first. Detail: `.ai/activeContext.md` §0e |

---

## Known Bugs / Gotchas
  - **✅ Fixed (2026-10-13) — OTP deadline/log storm:** The resolver stops when a complete 10s poll cannot fit in its 8-minute deadline; both paused-session registries now use the 9.5-minute OTP budget plus confirmation grace, and timeout text derives the `480s` budget.
  - **✅ Fixed (2026-10-13) — unsafe generic retries:** Only explicitly classified `BROWSER_LAUNCH_FAILED` results are eligible for the generic queue retry path. Required-field, unclassified, and thrown failures remain `FAILED` without incrementing `retry_count`; dedicated OTP retries remain separate.
  - **Confirmation verification needs proof-based diagnosis:** Two applications timed out after 30s on the same Greenhouse job and were attempted again. `runLiveSubmit` passes a 30s default even though `verifySubmissionSignals` has a 75s default, and its accepted signals are narrow. Inspect the stored failure screenshots/page evidence before adding a signal or changing the timeout; an unrecognized success could otherwise be resubmitted.
  - **Failure classification from the log:** Education-description values did not match discrete school-category choices, and a phone-shaped answer was rejected for a TikTok field. The filler correctly failed closed. Inspect each stored `resolved_fields` value and source/tier before changing form-filler behavior; these may be stale/bad answer data rather than a filler defect. The latest local resolver commit addresses a related choice-alignment case, but exact coverage of these logged questions is unverified.
  - **Browser disconnect warnings are misleading:** `BrowserManager` logs every `disconnected` event as unexpected, including its own explicit `browser.close()` path. The six warnings in this log do not establish six Chromium crashes; distinguish intentional release from external disconnect.
  - **Focused test status:** `tests/optionMatchingAlignment.test.ts` passes as a `tsx` script. OTP budget tests now assert the existing `QUEUED`/terminal `FAILED` contract and `480s` timeout.
  - **Systemic Pipeline Failures Diagnosed (2026-10-11 Sandbox Run — detailed in `claude_approval.md`):**
    - **OpenRouter Credit Exhaustion (HTTP 402) Halts Pipeline:** OpenRouter shared org account hit $50.00 credit cap. Both Tier 3 embedding generation (`text-embedding-3-small`) and Tier 5 batch queries throw HTTP 402, triggering the `[HALT]` LLM guard in `llmSynthesizer.ts`. Pipeline requires either topping up the OpenRouter organization balance or routing embeddings & Tier 5 to Gemini / alternative providers.
    - **SubmitterPool Backpressure Drain (562 `APPLYING`):** `dispatchQueue()` in `submitterPool.ts` loops infinitely without checking `this.getIdleCount() > 0`. It dequeues from PostgreSQL into in-memory worker buffers and mutates DB status `QUEUED -> APPLYING` within 2 seconds. When workers are halted, all buffered jobs remain stranded in `APPLYING`.
    - **OTP Premature Loop Abort (`break;`) (90 `OTP_REQUIRED`):** In `otpResolutionService.ts` line 229, an unconditional `break;` on the first poll miss aborts the 5-minute wait loop after 30 seconds. This kills Chromium and abandons applications in `OTP_REQUIRED`. Additionally, 67 `@applywizard.ai` mailboxes are routed to the Gmail API first, wasting 30 seconds before falling back to Zoho.
    - **Form Filler Exact-Match Inflexibility (56 `RETRY`):** `formFiller.ts` exact-match comparison fails on Unicode curly apostrophes (`Master’s Degree` vs `Master's Degree`) and verbose sentence options, leaving dropdowns on `Select...` and failing HTML5 validation.
    - **Tier 5 / Waterfall Fail-Closed (265 `READY_FOR_REVIEW`):** 253 applications were held in operator review because corporate trivia questions ("Have you interviewed here before?", "How did you hear about us?", arbitration/AI policy agreements, "County") lack resume context and Tier 5 returns unresolved.
  - **Architectural & Performance Gotchas (2026-10-10):**
    - **Frontend:** The Vite App.tsx bundle lacks code splitting, sending Admin/Manager code to standard operators. The legacy operator-app.jsx (4,300+ lines) is still actively injected via index.html.
    - **Backend:** listAllDashboardUsers and similar endpoints have no pagination, causing unbounded data fetching.
    - **Playwright:** The `formFiller.ts engine iterates over locators with procedural `for loops, causing severe CDP (Chrome DevTools Protocol) latency. Needs locator.evaluateAll().
    - **Node.js:** src/server/index.ts uses synchronous `fs.readFileSync for large JSON artifacts, blocking the Express main thread.
    - **Database:** updated_at timestamps on profiles and gh_candidate_qa_bank are frozen at row creation due to missing Postgres triggers. Core tables also defer RLS enforcement via USING (true).
- **✅ FIXED — CI build/typecheck/tests failed because `questionLimit.ts` lost the `QuestionLimitExceededError` export during merge:** restored the compatibility error class while retaining unlimited question eligibility; `npm run typecheck`, `npm run build`, and the CI unit-test set pass.
- **Historical only — invalid start-date answers in 2026-10-07 ingestion log:** pre-fix output used `01/05/1927` for `Date Available to Start?` and copied full desired-start dates into month/year components. The deterministic +7-day rule and component-field exclusion now prevent those paths; regression coverage is in `tests/resolverDiagnosedFixes.test.ts`.
- **Stats cutover previously hid same-day captured facts (2026-10-07):** migration 027 set `available_from` to the next IST day, so the dashboard hid events already captured on the migration day. Migration 028 repairs existing configuration using the earliest recorded event date; apply it to production. Pre-trigger history remains unrecoverable.
- **✅ FIXED — production dashboard stats migration missing (2026-10-07):** Railway logs showed `/api/dev/health` and `/api/admin/overview` failing because `gh_stats_config.available_from` was absent. Applied migration 027 in Supabase, verified both stats tables, the `available_from` value (`2026-10-08`), and the capture trigger, then the operator confirmed the production dashboard is working. The separate `gh_audit_events` RLS warning was not verified after recovery.
- **Large Greenhouse searchable lists remain partial:** required-only scanning avoids optional-field cost and the IMC diagnostic captured 100 School options in three bounded scroll passes, but marked the list partial. No school-options JSON payload appeared in inspected network responses; a full-list source/resolution path is still needed for large required searchable dropdowns.
- **✅ FIXED — missing dropdown choices in sandbox scanned templates:** the first local fixture used a synthetic click-only, non-portaled menu and passed despite not matching the Greenhouse control. The scanner now uses Playwright pointer interaction, reads portal-rendered options, and logs visible controls whose choices remain unavailable; user confirmed the fresh sandbox schema includes the missing choices.
- **✅ FIXED — sandbox scanned jobs missing from DB:** `exportScannedJobs` called the Supabase `.abortSignal()` method on the local `SandboxQueryBuilder`, causing a runtime `TypeError` after writing `output/scanned_jobs.json`; the Phase B catch treated it as a scan warning and ingestion still completed. Sandbox now awaits the local query builder directly, and export failures are no longer swallowed as scanner failures.
- **✅ FIXED — sandbox DB viewer misrendered `resolved_fields`:** `/dev/db` now pretty-prints object/array cells (including the `resolved_fields` JSONB array) as escaped, whitespace-preserving JSON, so `SELECT * FROM "gh_candidate_applications" LIMIT 50;` displays the field objects rather than `[object Object]`.
- **Gotcha — sandbox pgweb Compose entry is under `volumes`:** `docker-compose.sandbox.yml` declares `pgweb` under the top-level `volumes` key instead of `services`, so pgweb is not configured as a service and Compose may reject its volume definition.
- **✅ FIXED — `candidate_applications` FK after CSV ingest:** removed pre-resolve upserts (`ensureApplicationRowsFromCsv` / segregator). Ingest still syncs profiles first; application rows appear only after resolution (or SKIPPED over-cap)
- **✅ FIXED — Railway process crash on `/api/candidates`:** non-ASCII en-dash in `X-Dashboard-Date-Range` → Node `ERR_INVALID_CHAR`; use ASCII `-` and `sanitizeHttpHeaderValue()`
- **✅ FIXED — new `profiles` rows never insert (schema cache):** Railway 2026-09-15 logs — ApplyWizz fetch OK, PostgREST rejected `country`/`country_code` on `profiles`. Migration **016** adds columns; `upsertProfile` / profile patches strip any column missing from the schema cache and retry so creates are not blocked. **Apply 016 in Supabase SQL Editor** for country to persist
- **✅ FIXED — CSV uploads to Storage never started the pipeline:** there was no webhook, no Realtime listener, no DB trigger and no poller; `ingestCsvFromStorage` was reachable only via the one-shot `npm run ingest:storage` CLI and an admin route the dashboard never called. Now admin-driven via the **▶ Start** button on `/admin`.
- **✅ FIXED — Storage permission blindness reported as "no pending CSV files":** anon/publishable keys get `[]` with no error from `listBuckets()` and `from(bucket).list()`. Ingest probes every configured key (`0d02593`), logs `jwt.role` + names, fails if all lists are empty. Local `service_role` JWT sees `test(Sheet1).csv`. **Railway still reports entries=0** — process keys are not a Storage-capable `service_role` JWT
- **Gotcha — env vars set ≠ Storage can list:** `SUPABASE_SERVICE_KEY` = publishable and `SUPABASE_SERVICE_ROLE_KEY` = `sb_secret_` (or another anon) still yields empty lists. Need the legacy `eyJ…` `service_role` secret. Decode `role` from ingest `Probe` lines. Project ref: `dpwhgwdsfqzfwxlwvchp`
- **Gotcha — ingest run state is in-process memory:** `ingest-status` lives in `src/server/runtimeState.ts`, so a Railway restart mid-run reports `{running: false}` with no history — and the pipeline itself dies with the process. Only one run can be in flight per server instance
- **Gotcha — migration 015 writers fail-closed:** if `audit_events` / `application_events` are missing on an instance, inserts warn and continue. Operator applied 015 (tables + service_role RLS) on 2026-09-15
- **✅ FIXED — Duplicate live submissions (same app on 2–3 workers):** `PATCH /api/applications/:id/status` rewrote `APPLYING → QUEUED` unconditionally, and the dashboard's `handleStatusChange` echoed back the status its 2s badge poll just read — so an application a worker was mid-fill on got thrown back in the queue and immediately re-dequeued into another lane. Observed 6 submit clicks for one app (`b1f7250c`, AWL-31428 Prometheus). Fixes: the route skips requeue when current status is in `IN_FLIGHT_STATUSES` (now includes `EMAIL_PROOF_PENDING`; also blocks naked `PATCH` with `QUEUED` while in-flight); `SubmitterPool` tracks `inFlightApplicationIds`; poll-originated updates and **submit HTTP response handlers** pass `{ persist: false }` (observation 0008). **Not** an OTP/CAPTCHA requeue bug — no requeue-on-failure path exists anywhere in the codebase. See observation 0003
- **Gotcha — the dashboard `.tsx` tree is not the running UI:** production operator UI is `dashboard/public/index.html` (auth + `OperatorShell`) and lazy-loaded `dashboard/public/operator-app.jsx`; styles are `dashboard/public/dashboard.css` (`npm run build:dashboard-css`). `dashboard/App.tsx` and `components/*.tsx` remain an unserved parallel copy — **ship operator UI changes in `index.html` / `operator-app.jsx`**, not only in `.tsx`
- **✅ FIXED (2026-09-15) — 35 type errors in the dashboard `.tsx` tree**, from four root causes: (1) `CandidateDetail['jobs']` lacked the `applywizz_id`/`applywizzId` tags that `filterJobsForCandidate` reads, and because `JobWithOptionalOwner` is an all-optional *weak type*, TS rejected the call and fell back to the constraint — which cascaded into ~22 property errors in `JobQueueView.tsx`; (2) three divergent `ApplicationStatus` unions — `dashboard/types.ts` now re-exports the canonical one from `src/db/applications.ts`; (3) `ResolvedField.isRequired` added to `src/types/index.ts`; (4) TDZ crash in `App.tsx` WebSocket effect moved below callbacks. **The active `src/types/index.ts` union now excludes the legacy `EMAIL_UNVERIFIED` status.**
- **Enforced since 2026-09-15:** `dashboard/tsconfig.json` (`noEmit`, same strictness as root) covers the whole tree, and `npm run typecheck` is now `tsc --noEmit && npm run typecheck:dashboard`, so the tree cannot silently re-accumulate errors. Verified with a positive control: a deliberately broken `.tsx` makes `npm run typecheck` exit 2. `npm run build` and the Dockerfile still run plain `tsc` on `src/` only, so the Railway deploy is unaffected
- **✅ FIXED — OTP email captured as email proof:** `queryZohoConfirmationEmail` used a ±5min window around submission, so the Greenhouse security-code mail that arrives *before* the submit landed inside the window and was stored as `proof_email_json`. The window is now forward-only (`submitted_at` → `+10min`, matching the poller budget), OTP/security-code subjects are explicitly rejected (logged), and a row must come from `greenhouse-mail.io` with a `thank you` / `application received` / `application confirmed` subject. The dead `sinceTimestamp` option on `captureAndSaveEmailProof` (3 call sites passed `submitted_at - 2min` into a parameter that was never read) is gone. `emailProofPoller.ts` additionally skips any cycle where status is not `EMAIL_PROOF_PENDING`, so nothing is captured mid-OTP flow
- **Gotcha — accept window is tied to the poller budget:** the connector accepts `submitted_at` → `+10min`, deliberately matching `emailProofPoller`'s 10min retry budget. If that budget changes, `WINDOW_MS` in `zoho-connector.ts` must change with it, or late confirmations silently end in `manual_review_needed`
- **✅ FIXED — Zoho OTP false positives:** `fetchLatestOtp` now gates on sender + subject + company via `isGreenhouseOtpEmail()` **before** any regex runs, scans 15 messages (was 3), and returns `reason: 'no matching greenhouse OTP email found'` rather than falling through to unrelated mail. Two bugs were behind this: Pattern 2 (`\b[A-Za-z0-9]{8}\b`) lifted `jobs2web` from a PG&E job-alert, and on the real Greenhouse email it returned the candidate name `Akshitha` instead of `NgW4NT62`. Added Pattern 0 for Greenhouse's "Copy and paste this code … : CODE" wording (the label and code are separated by a clause, which the old adjacency-based Pattern 1 could not match) and tightened Pattern 2 to require a digit **and** a letter. Verified live against AWL-31428 → `NgW4NT62`. See observation 0002
- **Gotcha — `extractOtpCode` is not safe standalone:** it is a pure extractor with a deliberately permissive last-resort pattern; an 8-char token like `jobs2web` is shape-indistinguishable from a real code. It must only ever be called on a message that has already passed `isGreenhouseOtpEmail()`
- **✅ FIXED — Zoho OTP leftover filter / empty user list:** a reused Playwright page kept the previous email in the filter. `resetUiBeforeLookup` now goto-root + clear; empty list retries once with `page.reload()` (`601d37d`). See observation 0010
- **Zoho Reader login is effectively a no-op:** connector inbox access is server-side OAuth per mailbox, not session-based — login yields **0 cookies** and no POST request, yet mail reading works. The post-login success check resolves via the *fallback* filter-input selector, so a failed login is not detectable. `ZOHO_CONNECTOR_USER` in `.env` currently holds a password-shaped value rather than an email (check `.env` directly) and nothing rejects it
- **`zoho_connected_profiles` missing:** migration 011 is not applied on the current Supabase instance (`Could not find the table 'public.zoho_connected_profiles'`)
- **Manager API in browser:** Opening `/api/manager/dashboard` without `Authorization: Bearer` always returns 401 — sign in at `/`, then you are redirected to **`/manager`**
- **Demo job scores:** Akshitha fixture jobs use scores 90–95; dashboard score filter (20–60) is bypassed for pinned demo IDs only
- **E2E integration** (`npm test`): 28/32 checkpoints pass locally; Tier 1 “Email” resolution assertions fail while dry-run still fills email via `company_email` — investigate resolver profile/email mapping, not a dashboard blocker
- Local dev defaults LLM to **Ollama** (`llama3.1:latest`) — will fail silently if Ollama isn't running; override with `LLM_PROVIDER=openrouter`
- `RAILWAY_ENV=true` must be set on Railway or headful Playwright will try to open a display and fail
- `candidate_resume_parsed` is parsed once and cached; if resume changes, the old parse is stale — no auto-invalidation
- The `< 35` field count filter runs at scan/resolve time (`MAX_JOB_QUESTIONS=35`); over-cap jobs persist as `SKIPPED` (migration 014). Changing the cap requires re-resolve for already-SKIPPED rows
- **React-Select combobox:** Do not use keyboard Enter as a fallback after failed option click — it clears the type-ahead without committing (use option click or flyout toggle). Full-page option search uses `page.locator('body')` (Locator, not Page) for portaled menus.
- **Local dry-run script** (`runUserApplication.ts`) is separate from dashboard `POST .../dry-run` (`dryRun.ts` + Supabase application row)
- **Gotcha — same column labels, three different windows (2026-09-18):** `Assigned` is the operator **email string** on Home, a **period-scoped count** on the Operators summary card, and an **all-time count** in the new Reports column. `Completed` is **today-IST only** on Home's card and on Operators (`countCompletedApplicationsByOperatorSince(getISTDateRangeUtc(getISTDateString()).startIso)` ignores the date filter) but **period-scoped** in the new Reports column. Managers comparing tabs will read the differences as bugs.
- **Pre-launch audit risk — form filler can falsely mark selects filled:** `formFiller.ts` marks the misclassified native-select path successful even after both `selectOption` attempts fail, and marks location autocomplete successful when no option is committed; required-field gating trusts the resolved value rather than the actual control state.
- **Pre-launch audit risk — resolver may submit incorrect identity answers:** the work-authorization pre-tier rule unconditionally selects Yes for matching non-question labels, while required EEOC fields without structured candidate data can reach Tier 5 and receive an unverified LLM choice.
- **Pre-launch audit risk — successful submissions can be reported FAILED:** confirmation verification recognizes only a narrow fixed set of titles, URLs, and body phrases; a successful Greenhouse response using other wording times out and becomes retryable FAILED.
- **Pre-launch audit risk — empty resolution can overwrite existing answers:** `upsertApplication` ignores errors from the pre-read used to preserve non-empty `resolved_fields`, then the Supabase upsert can replace the existing JSONB array with all-empty values.
- **Pre-launch audit risk — stale APPLYING recovery has no failure circuit breaker:** each dispatch cycle retries recovery, treats a database error as zero recovered rows, and continues polling; stale claims remain APPLYING while the error persists.
- **Pre-launch audit risk — status persistence errors are swallowed in submission routes:** RETRY/FAILED writes can fail while the route returns a status response, leaving the database row in its earlier state; route-level APPLIED writes are redundant with the submit helpers' persisted APPLIED transition.
- **Pre-launch audit risk — automatic status pushes are not delivered:** worker status transitions bypass the route-level WebSocket broadcaster, and the legacy Supabase listener targets `candidate_applications` instead of the published `gh_candidate_applications` table; the active badge refreshes by polling.
- **Pre-launch audit risk — production mode and CORS depend on exact environment values:** `NODE_ENV` defaults to development, allowing the internal-secret middleware's development bypass when unset; `ALLOWED_ORIGINS` is split without trimming, so whitespace after commas prevents matching.
