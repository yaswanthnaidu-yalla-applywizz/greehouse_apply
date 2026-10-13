## Current Session Update (2026-10-13 — Application Queue Export, Cleanup & Stats Alignment)

- **Application Queue Transition & Export (`queued_applications_export_2026-10-13T16-17-24-402Z.csv`)**:
  - Identified all applications outside of the protected set (`APPLIED`, `EMAIL_PROOF_PENDING`, `READY_FOR_REVIEW`) and transitioned them to `QUEUED` (332 applications transitioned).
  - Queried all 703 `QUEUED` applications and exported them matching the exact ingest reference CSV format (`company_name,job_url,score,lead_name,applywizz_id`), referencing candidate lead names from [`greenhouse-jobs-2026-10-09.csv`](file:///C:/Users/yaswa/Dev/greehouse_apply/greenhouse-jobs-2026-10-09.csv) and profiles table.
  - Successfully exported **703 applications** to [`queued_applications_export_2026-10-13T16-17-24-402Z.csv`](file:///C:/Users/yaswa/Dev/greehouse_apply/queued_applications_export_2026-10-13T16-17-24-402Z.csv).
  - Deleted all 703 `QUEUED` application records from `gh_candidate_applications` and deleted their 3,816 associated events from `gh_application_events`.
  - Synced `gh_stats_rollups` with true ground truth database counts (`total: 636`, `submitted: 250`, `applied: 250`, `failed: 0`).
  - Remaining applications in database strictly consist of:
    - `READY_FOR_REVIEW`: **386**
    - `APPLIED`: **131**
    - `EMAIL_PROOF_PENDING`: **119**
    - Total: **636**

## Current Session Update (2026-10-13 — Auto-Retry Browser Launch & Mailbox-Gated OTP & Multi-Replica Heartbeat Fix)

- **Multi-Replica Worker Heartbeat Isolation & Cluster Rollup (`src/submitter/submitterPool.ts`, `src/server/healthSnapshot.ts`)**:
  - In [`src/submitter/submitterPool.ts`](file:///C:/Users/yaswa/Dev/greehouse_apply/src/submitter/submitterPool.ts), updated `writeHeartbeat()` to write with `service_name = 'submitter_pool:' + process.env.RAILWAY_REPLICA_ID` (falling back to `'submitter_pool'` when not in a multi-replica container). This eliminates row overwrite conflicts between concurrent Railway replicas.
  - In [`src/server/healthSnapshot.ts`](file:///C:/Users/yaswa/Dev/greehouse_apply/src/server/healthSnapshot.ts), updated `collectHealthSnapshot()` to query all matching `service_name.eq.submitter_pool,service_name.like.submitter_pool:%` updated within 30 seconds, dynamically summing `worker_count`, `idle_count`, and `in_flight_count` across all active replicas.
- **Auto-Retry for Browser Launch & OTP Errors (`src/submitter/submissionRetry.ts`, `src/services/otpResolutionService.ts`)**:
  - **Browser Launch Errors**: `BROWSER_LAUNCH_FAILED` is already wired into `isAutomaticRetryAllowed()` and `submitterPool.ts`. On launch failure, the worker automatically requeues the application back to `QUEUED` with incremented `retry_count` and prioritized submission order (capped at `MAX_SUBMISSION_RETRIES = 3`).
  - **OTP Errors (OTP Not Received / Timeout)**:
    - Updated `OtpResolutionService.processEntryInContext` to check candidate mailbox connection (`profile?.zoho_connected !== false`) via `getProfile(application.applywizz_id)` on timeout/poll budget exhaustion.
    - If the mailbox is **connected** and `retry_count < MAX_SUBMISSION_RETRIES`, the application is safely requeued to `QUEUED` with `retry_count = retry_count + 1`.
    - If the candidate's mailbox is **not connected** (`zoho_connected === false`), retry is bypassed and the application is transitioned to terminal `FAILED` immediately with an informative reason (`mailbox is disconnected`).
  - **Database Migrations Assessment**:
    - **No database migrations required.** The status transitions remain within existing permitted enum values (`QUEUED`, `FAILED`, `OTP_REQUIRED`) and `retry_count` is already supported by the schema and Postgres RPC `get_next_queued_application()`.
- **Validation**:
  - `tests/submissionRetry.test.ts` (PASS, 2/2)
  - `tests/submitterPoolRetry.test.ts` (PASS, 5/5)
  - `tests/otpResolution.test.ts` (PASS, 12/12)
  - `npm run typecheck` passed cleanly across server and dashboard.

## Current Session Update (2026-10-13 — Client Info Drawer & 2-Tier Mobile Header Layout)

- **Client Info Drawer (`dashboard/components/ClientInfoDrawer.tsx`, `tests/clientInfoFormatting.test.ts`)**:
  - Slide-over drawer providing comprehensive candidate details (`awl_id`, `name`, `company_email`, `phone`, `country`, `location`, `linkedin_url`, `website_url`, `github_url`, `work_auth`, `sponsorship`, `education`, and `experience`).
  - Added formatted vertical card lists for education and work experience (skipping raw JSON strings).
  - Automatically filters out empty/null/undefined candidate fields.
  - Backdrop blur and dismissal via backdrop click or `Escape` key.
- **JobQueueView & App.tsx Integration (`dashboard/JobQueueView.tsx`, `dashboard/App.tsx`, `tests/clientInfoIntegration.test.ts`)**:
  - Wired `👤 Client Info` pill button adjacent to `📄 Master Resume PDF`.
  - Passed `onOpenClientInfo` to toggle drawer state cleanly without disrupting job queue layout.
- **2-Tier Mobile Header Layout (`dashboard/App.tsx`, `tests/mobileHeaderLayout.test.ts`)**:
  - Redesigned mobile header (`< 768px`) into a 2-tier structure eliminating crowded/overlapping controls:
    - **Tier 1 (Main Header):** Brand logo + notifications bell (`🔔`) + user avatar/sign out.
    - **Tier 2 (Sub-bar):** Date filter (`📅 IST`), refresh button (`↻`), and DevSwitcher with comfortable touch targets.
  - Preserved single-row desktop layout (`hidden md:flex h-16`) intact.
- **Validation**:
  - `tests/clientInfoFormatting.test.ts` (PASS, 4/4)
  - `tests/clientInfoIntegration.test.ts` (PASS, 1/1)
  - `tests/mobileHeaderLayout.test.ts` (PASS, 1/1)
  - `npm run typecheck` (`tsc --noEmit && npm run typecheck:dashboard`) passed with 0 errors.

## Current Session Update (2026-10-13 — Dual Mailbox Ingest Sync & Candidate Round-Robin Dequeue)

- **Dual Mailbox (Zoho + Gmail) Sync & Gate (`src/services/zohoConnectionCheck.ts`, `scripts/scanZohoConnected.ts`, `src/resolver/answerResolver.ts`)**:
  - `fetchConnectedEmails` queries both `/api/zoho/ui/users` and `/api/gmail/ui/users` concurrently via `Promise.allSettled`, normalizing and combining all mailboxes where `user.connected === true`.
  - Updated `scripts/scanZohoConnected.ts` to sync both services to `profiles.zoho_connected`.
  - In `resolveAllApplications`, strictly gated answer resolution to candidate segments where `profile?.zoho_connected !== false`.
- **Candidate Round-Robin Dequeue & Migration 034 (`src/db/migrations/034_candidate_round_robin_dequeue.sql`, `src/db/applications.ts`)**:
  - Created Migration 034 adding composite index `idx_applications_round_robin_queue` and updating stored procedure `get_next_queued_application()` with candidate-level window ranking (`candidate_rank = prior processed count + queued position`) with atomic `FOR UPDATE OF ca SKIP LOCKED`.
  - Implemented `selectNextRoundRobinAppInMemory` in `src/db/applications.ts` and updated the Supabase query fallback and in-memory queue fallback to enforce identical candidate interleaving.
- **Validation**:
  - `tests/zohoConnectedFilter.test.ts` (PASS, 7/7)
  - `tests/roundRobinDequeue.test.ts` (PASS, 3/3, including 3-worker starvation simulation)
  - Full `npm run test:vitest` (PASS, 55/55)
  - `npm run typecheck` passes with 0 errors.

## Current Session Update (2026-10-13 — Operator Dashboard Carousel Actionable Filtering)

- **Actionable Question Filtering (`dashboard/utils/fieldFilters.ts`, `dashboard/FormRenderer.tsx`)**:
  - Implemented `isActionableCarouselField` to restrict card carousel review strictly to:
    1. Required Unresolved fields (`isRequired === true && source === 'unresolved'`)
    2. Required AI-resolved fields (`isRequired === true && source === 'ai'`)
    3. Optional AI-resolved fields (`isRequired === false && source === 'ai'`)
    4. Manually edited fields (`source === 'manual' || isEdited === true`)
  - Excluded profile identity fields (`first_name`, `last_name`, `email`, `phone`) and non-AI profile/resume resolved fields from the carousel.
  - Carousel progress bar and approval counter strictly reflect the filtered actionable questions.
  - Added empty-state card when 0 review questions exist (with direct "Approve & Submit" and "Inspect Full List" options).
  - Preserved 100% full field view when switched to "Switch to Full List" mode.
- **Validation**:
  - `tests/fieldFilters.test.ts` (PASS, 7/7)
  - `tests/formRendererFiltering.test.ts` (PASS, 3/3)
  - `npm run typecheck` and `npm run typecheck:dashboard` pass with 0 errors.

## Current Session Update (2026-10-13 — Form Validation & Demographic Fixes for Terminal Failures)

- **Demographic Race Labeling & EEO Fallback (`src/resolver/answerResolver.ts`, `src/resolver/tier1Supabase.ts`, `src/submitter/formFiller.ts`)**:
  - Broadened race regex patterns to match "Please identify your race" and "Please identify your race/ethnicity".
  - Extended Tier 1 structured resolver to match candidate race from `additional.raceEthnicity` and `payload.demographics`.
  - Added DOM fallback `resolveEeoFallbackOption` in `formFiller.ts` to select employer decline options for required demographic dropdowns when no candidate preference is matched.
- **Mandatory Cover Letter Gate (`src/resolver/needsReview.ts`)**:
  - Added gate routing applications to `READY_FOR_REVIEW` when a cover letter is mandatory (`field.required === true`), preventing headless submit timeouts.
- **Education Cascading Fallbacks (`src/submitter/formFiller.ts`)**:
  - Added `applyEducationFieldFallbacks` providing default degree, discipline, start date, and end date when Greenhouse renders an unfilled mandatory education block.
- **International Phone Formatting Safeguard (`src/submitter/formFiller.ts`)**:
  - Implemented `sanitizePhoneNumberForSubmission` ensuring prefix stripping only applies to numbers with 11+ digits, protecting 10-digit international phone numbers from corruption.
- **Validation**:
  - `tests/demographicRaceMatching.test.ts` (PASS, 4/4)
  - `tests/mandatoryCoverLetterReview.test.ts` (PASS, 2/2)
  - `tests/educationFallbacks.test.ts` (PASS, 2/2)
  - `tests/phoneFormatting.test.ts` (PASS, 4/4)
  - `npm run typecheck` passes with zero type errors.

## Current Session Update (2026-10-13 — STAR Methodology LLM Synthesis for Open-Ended Questions)

- **STAR Question Classifier (`src/resolver/starClassifier.ts`)**:
  - Implemented `isBehavioralOrMotivationalQuestion` to detect open-ended behavioral prompts ("Have you worked with...", "Tell us about a time...", "Describe a project...") and motivational prompts ("Why choose our company...", "Why are you interested in this role?").
  - Strictly excluded choice/select/radio/checkbox fields, demographic/EEO fields, URLs, contact numbers, and salary fields.
- **LLM Synthesizer Prompt Directives (`src/resolver/llmSynthesizer.ts`)**:
  - Embedded STAR guidelines into `buildSinglePrompt` and `buildBatchPrompt` / `systemMessage` (CREATIVE RULE).
  - Constrained responses to a concise single paragraph of approximately 50 to 80 words without artificial section headers or bullets.
  - Enforced a confident first-person narrative ("I led...", "In my role at...") grounded strictly in actual candidate resume history, verified projects, and QA bank entries.
- **Context Grounding (`src/resolver/candidateEvidence.ts`)**:
  - Added support for candidate QA bank answers (`qaBankAnswers`, `qa_bank`) in evidence extraction so behavioral responses maintain consistency with past candidate interview answers.
- **Validation**:
  - `tests/starClassifier.test.ts` (PASS, 4/4)
  - `tests/starPromptSynthesis.test.ts` (PASS, 4/4)
  - `tests/starGroundingContext.test.ts` (PASS, 1/1)
  - `tests/starSynthesisRegression.test.ts` (PASS, 3/3)
  - Regressions clean: `optionMatchingAlignment.test.ts`, `filteredOutRouting.test.ts`, `autoQueueAndCaNotification.test.ts`, `formFillerNormalization.test.ts`.

## Current Session Update (2026-10-13 — Signal-to-Noise Logging Optimization across Worker & Ingest)

- **Centralized Log Level Filtering (`src/utils/logger.ts`)**:
  - Implemented and exported `shouldLogMessage(level, configuredLevel)` with strict severity levels (`DEBUG: 10`, `INFO: 20`, `WARN: 30`, `ERROR: 40`, `HALT: 50`).
  - `WARN`, `ERROR`, and `HALT` are always emitted regardless of configured log level.
  - `emit()` checks `process.env.LOG_LEVEL` (defaults to `INFO`), eliminating intermediate debug noise in production while preserving milestones, stats, warnings, and errors.
  - Covered by unit and integration tests in `tests/loggerFiltering.test.ts`.
- **Worker & Submitter Pipeline Decluttering (`src/submitter/formFiller.ts`, `src/submitter/liveSubmit.ts`)**:
  - Downgraded per-keystroke/selector debug logs (`[FormFiller] Stage 1/2/3 match`, `[Sponsorship DEBUG]`, `Country code field → selector`, `Boolean field → clicked`) to `log.debug()`.
  - Preserved critical completion stats and operational milestones: resume uploads, form fill completion ratios (`Finished filling form: X/Y successful, Z failed`), and terminal verification/submission statuses.
- **Ingest Pipeline Decluttering (`src/resolver/answerResolver.ts`)**:
  - Downgraded per-field resolution attempts (`[Resolver] ✅ T1/T2/T3/T4/T5`, `[Resolver] ❌ T1/T2/T3/T4/T5`) to `log.debug()`.
  - Retained candidate resolution summaries, phase metrics, auto-queue notices, filter-out notices, and batch rollups at `log.info()`.
- **Validation**:
  - `tests/loggerFiltering.test.ts` (PASS, 6/6 tests)
  - `tests/optionMatchingAlignment.test.ts` (PASS)
  - `tests/filteredOutRouting.test.ts` (PASS, 11/11 tests)
  - `tests/autoQueueAndCaNotification.test.ts` (PASS, 16/16 tests)
  - `tests/formFillerNormalization.test.ts` (PASS, 11/11 tests)

## Current Session Update (2026-10-13 — Choice Option Matching & Form Filling Fixes)

- **Routing Policy Update (Auto-Queue vs. Review vs. Filtered-Out):**
  - **Auto-Queue (`QUEUED`)**: Strictly requires **100% of required fields to be resolved without AI** (all resolved by Tiers 1–4: Supabase, Resume, Semantic, or Fuzzy), zero unresolved required fields, and valid salary expectations.
  - **Ready for Review (`READY_FOR_REVIEW`)**: Holds applications where any required field was solved by AI (`source === 'ai'`), or where unresolved required count is $1 \dots 3$, or where unresolved required $> 3$ but total AI $\le 3$.
  - **Filtered Out (`FILTERED_OUT`)**: Triggers when both unresolved required fields $> 3$ AND total AI fields $> 3$.
  - **Tests**: Verified and passing in `tests/autoQueueAndCaNotification.test.ts` and `tests/filteredOutRouting.test.ts`.

- **Root Causes Diagnosed and Resolved:**
  - **School bypass bug in `alignResolvedChoice`**: `isSchoolField` broadly matched any question containing the word `institution` (such as OPT extension questions), allowing answers like `"University of South Florida"` to bypass static option matching when the only valid options were `["Yes", "No", "Not Applicable"]`. Narrowed `isSchoolField` to exclude questions with boolean/choice options and non-school eligibility questions.
  - **Tier 1 Structured Payload Matcher**: Prevented `university|institution` regex from mapping eligibility, OPT, and STEM questions to the candidate's university name.
  - **En-dash / Em-dash / Hyphen mismatch**: Normalized unicode dashes in `matchDropdownOption` and `fuzzyOptionTextMatch` to standard ASCII hyphens (`-`), allowing salary and range options (e.g. `"$100,000 – $110,000"`) to match Greenhouse DOM `<option>` values.
  - **Demographic Decline Matching**: Added EEO decline phrasing detection in `fuzzyOptionTextMatch` and enabled it for `isDemographicOrEeoField` in searchable select controls, enabling `"Decline To Self Identify"` to match company-specific variants like `"Decline to self-identify"`, `"I do not wish to disclose"`, or `"Prefer not to say"`.
- **Validation**:
  - `tests/optionMatchingAlignment.test.ts` (PASS)
  - `tests/choiceOptions.test.ts` (PASS)
  - `tests/formFillerNormalization.test.ts` (PASS)
  - `tests/resolverDiagnosedFixes.test.ts` (PASS)

## Current Session Update (2026-10-13 — Submission Log Root-Cause Diagnosis)

- **✅ OTP timeout/log storm fixed (2026-10-13):** Shared timing constants now align the 8-minute OTP budget, 10-second poll interval, and 9.5-minute paused-session TTL (including the 90-second confirmation grace). The resolver stops before a poll that cannot fit and reports the configured `480s` timeout, eliminating the zero-poll tight loop. Focused tests and `npm run typecheck` pass.
- **✅ Unsafe generic retries fixed (2026-10-13):** The pool now retries only explicit `BROWSER_LAUNCH_FAILED` results. Required-field failures, unclassified results, and thrown errors are persisted as `FAILED` without incrementing `retry_count`; existing proof fields are left untouched. The generic DB retry helper requires the typed eligible reason and no longer transitions from `OTP_REQUIRED`; the dedicated OTP timeout path remains unchanged.
- **Confirmation failures:** Two separate applications timed out on the same Greenhouse job after 30 seconds. The submitter passes 30 seconds despite the verifier's 75-second default; inspect failure proofs and widen only for observed confirmation signals before changing matching behavior.
- **Answer mismatches:** The log shows education text passed to discrete school-category choices and a phone-shaped value rejected for a TikTok field. The form filler correctly fails closed; inspect stored resolved-field values and tier/source before changing the filler.
- **Diagnostics:** BrowserManager labels every Playwright `disconnected` event unexpected, including explicit closes; separate intentional cleanup from crashes. `tests/otpResolution.test.ts` also has two stale assertions expecting `RETRY` while code now persists `QUEUED`.
- No application code changed in this diagnosis. Focused validation: option-alignment script passed; two OTP assertions failed as noted above.

## Current Session Update (2026-10-13 — Chromium Crashes & Worker Concurrency Optimization)

- **Centralized Browser Lifecycle Manager (`src/submitter/browserManager.ts`)**:
  - Implemented `BrowserManager` providing an authoritative counting semaphore capped at `MAX_CONCURRENT_BROWSERS` (default `5`), protecting memory limits on Railway Pro.
  - Implemented launch throttling queue with `BROWSER_LAUNCH_COOLDOWN_MS` (default `1500`ms) to space Chromium process forks, eliminating burst CPU and cgroup memory spikes.
  - Handled launch errors non-fatally: removed `haltWithDevAlert` (which called `process.exit(1)`) on browser launch failure in `liveSubmit.ts`, replacing with structured `SUBMIT_PLAYWRIGHT_LAUNCH` diagnostic and status `FAILED` with retry reason `BROWSER_LAUNCH_FAILED`.
  - Added periodic zombie browser cleanup (every 60s) and graceful shutdown (`closeAll()`) in `server/index.ts`.
- **Worker Pool Sizing & Metrics Calibration**:
  - Clamped `SUBMISSION_POOL_SIZE` and `WORKER_CONCURRENCY` to safe default of `3` (max `6`).
  - Added browser pool utilization metrics (`browser_active_count`, `browser_waiting_count`, `browser_max_count`) into `system_worker_heartbeats`.
- **Unified Paused Session Registry**:
  - Linked `PAUSED_SESSIONS` and `activeSubmissions` so closing/clearing a session purges both stores and releases the managed browser slot cleanly.

## Current Session Update (2026-10-13 — Ingest LLM Timeout & Deferred Auto-Queue Submissions)

- **Root Cause Fixes for Ingestion & Submitter Concurrency Collisions**:
  - **OpenRouter LLM Request Timeout Resolved (`src/config/env.ts`, `src/resolver/llmSynthesizer.ts`)**:
    - Discovered 100% of errors in `logs.1791829492497.log` were `RESOLVE_TIER5_PROVIDER_FAILURE` / `t5_batch_provider_failure` caused by hardcoded `8000ms` client timeout with 1 retry (timing out at ~16.7s) on 6–8 question batch syntheses using OpenRouter `google/gemini-2.5-flash`.
    - Added configurable `LLM_TIMEOUT_MS` (default `30000ms`, 30s) in `src/config/env.ts` and updated OpenAI/OpenRouter client initializations in `src/resolver/llmSynthesizer.ts`.
  - **Tier 4 UUID Rejection for Non-Identifier Fields (`src/resolver/answerResolver.ts`)**:
    - Addressed warnings where historical QA bank UUIDs (e.g. applicant IDs) fuzzy-matched into non-identifier fields (`County`, `Additional links`).
    - Discarded UUID-shaped QA bank answers in `resolveTier3` fuzzy search before accepting matches.
  - **Deferred Auto-Queue Submissions (`src/resolver/answerResolver.ts`, `src/services/caNotificationEmail.ts`, `src/orchestrator/pipeline.ts`, `src/resolver/runResolver.ts`)**:
    - Ingest previously transitioned auto-queue eligible applications immediately to `QUEUED`, triggering the background submitter daemon to spin up up to 15 concurrent Playwright Chromium instances while ingest was running, leading to container OOM and `browserContext.newPage: Target crashed` (`EAGAIN`).
    - Decoupled resolution from immediate enqueueing. Applications are persisted initially as `READY_FOR_REVIEW` and buffered in memory (`pendingAutoQueue`).
    - Provided buffer inspection and flush methods: `getPendingAutoQueue()`, `getPendingAutoQueueCount()`, and `flushPendingAutoQueue(): Promise<number>`.
    - Filtered pending auto-queued applications out of CA review notification emails (`sendCaNotificationEmails` / `groupReadyForReviewByCa`) via `excludeKeys` (`${applywizz_id}::${job_url}`).
    - Flushed buffered applications to `QUEUED` in `Pipeline.run()` only after Phase E completes and in `runResolver.ts`.
  - **Verification**:
    - Full TypeScript typecheck clean (0 errors).
    - Unit test suite clean: 48 vitest tests, all node tests passed.
    - Code review approved with 0 Critical / 0 Important findings.

## Current Session Update (2026-10-12 — Remote DB Profiles Data Audit, Resume PDF Extraction & Normalization)

- **Comprehensive Profile Data Audit & Anomaly Identification (`scripts/auditProfileAnomalies.cjs`)**:
  - Audited all 370 profiles in the remote Supabase database (`postgres-db2`, project `rrqsqakctbrhqcoqavoj`):
    - **Empty Fields Identified**: `location`: 156, `phone`: 209, `country`: 156, `country_code`: 235.
    - **Root Cause of Empty Fields**: Early ingestion only parsed resume facts into `resume_facts` (skills, education, experience) and left top-level profile contact fields empty. Candidates' raw contact data was stored in `raw_api_payload` (`additional_information` & `client`: `full_address`, `state_of_residence`, `primary_phone`, `callable_phone`). For 60 candidates, phones in CRM were dummy values (`'+'`), but their S3 resume PDFs contained verified phone numbers.
    - **Wrong / Anomalous Values Identified**:
      - `country`: 28 rows had a US State name (e.g. `'Texas'`, `'Missouri'`, `'New Jersey'`, `'California'`, `'Ohio'`) instead of `'United States'`.
      - `location`: 17 rows had non-canonical formats (`'Onsite'`, `'Missouri, United States'`, `'Dublin'`, `'Manor park'`, `'Buckinghamshire'`).
      - `phone`: 1 row had `< 10 digits` (`'899539166'`).
- **Comprehensive 3-Part Normalization & Live Backfill (`scripts/backfillProfileDataFromPayloadAndResume.cjs`)**:
  - Integrated `docs/DASHBOARD CONFIRMATION.csv` priority for operator-verified contact details.
  - Built waterfall parser for `raw_api_payload` and implemented on-the-fly S3 resume PDF download and parsing via `axios` + `pdf-parse`. Extracted missing phone numbers directly from candidate resumes and saved `resume_text`.
  - Normalized all candidate locations to canonical 3-part Greenhouse format (`City, State, Country`).
  - Replaced US State names in `country` with `'United States'` and mapped dialing codes to `country_code` (`+1`, `+44`, `+353`, `+61`, `+91`).
  - Executed live updates via Supabase port 6543 (transaction pooler).
  - **Final Verified Results Across 370 Remote DB Profiles**:
    - `with_location`: **369 / 370** (100% of real candidates; remaining 1 is dummy test account `CASCADE-TEST-1`)
    - `with_phone`: **369 / 370** (100% of real candidates)
    - `with_country`: **369 / 370** (100% of real candidates)
    - `with_linkedin`: **246 / 369** (extracted from CSV, CRM payloads, and PDF `/URI` hyperlinks; remaining 123 candidates only have Vercel portfolio apps and no LinkedIn on file)
    - `non_3part_location`: **0** (100% compliant with Greenhouse `City, State, Country` requirement)
    - `state_in_country`: **0** (100% resolved)
    - `phone_invalid`: **0** (100% valid; fixed `AWL-36169` to `+353 89 953 9166`)

## Current Session Update (2026-10-12 — Remote DB Profiles Sync, Dashboard Confirmation, Zoho & CA Email Backfill)

- **Remote Supabase DB (`postgres-db2`) Profiles Synchronization**:
  - Identified **126 missing AWL IDs** in remote DB compared to local sandbox DB (365 in sandbox vs 244 in remote).
  - Migrated and inserted all 126 missing candidate profiles into remote `profiles` table, bringing total remote profiles to **370**.
- **Candidate Profile Location, Phone, LinkedIn Extraction & 3-Part Normalization**:
  - Implemented `scripts/backfillProfileDataFromPayloadAndResume.cjs` extracting missing values from `raw_api_payload` and `resume_text`.
  - Normalized all candidate locations to canonical 3-part Greenhouse format (`City, State, Country`).
  - Remote DB profile stats: `with_location: 342`, `with_phone: 282`, `with_country: 342`, `with_linkedin: 235`, `with_github: 79`, `with_ca_email: 370`.
- **Zoho Connected Status Backfill**:
  - Fetched all active mailboxes from `https://zoho-mail-reader.onrender.com/api/zoho/ui/users`.
  - Backfilled `zoho_connected` on remote DB: **254 candidates marked `true`**, 116 marked `false`.
- **CA Email Assignment Backfill**:
  - Paginated through ApplyWizz CA work history (`https://applywizz-ca-management.vercel.app/api/ca/work-history`, 83 pages / 8,266 records).
  - Successfully mapped and updated `ca_email` across all **370 / 370 profiles** (100% coverage, 0 missing).

## Current Session Update (2026-10-12 — OpenRouter Gemini 2.5 Flash with Prompt Caching, Direct Token Cost & 1536 Vector Revert)

- **OpenRouter Primary LLM Integration with Google Gemini 2.5 Flash (`google/gemini-2.5-flash`)**:
  - Configured `LLM_PROVIDER: 'openrouter'` and `OPENROUTER_MODEL: 'google/gemini-2.5-flash'` in `src/config/env.ts` and `.env.example`.
  - Added `'X-OpenRouter-Cache': 'true'` header on OpenRouter client chat completion requests.
  - **Candidate Cache Isolation Guarantee**: Formatted candidate identity block (`ApplyWizz ID`, name, contact, authorization, demographics) at the absolute beginning of the prompt/message prefix. This ensures candidate A's prompt cache prefix never matches candidate B's, isolating caches completely.
  - **Direct Cost & Cache Hit Metrics Extraction**: Extracted `usage.cost` (USD) and `usage.prompt_tokens_details.cached_tokens` from OpenRouter API responses.
- **Per-Application Token Usage Cost Tracking**:
  - Updated `src/db/tokenUsage.ts` and `src/resolver/tier5LLM.ts` to record provider-reported direct cost (`input.cost`) rather than a hardcoded static formula.
- **Reverted Tier 3 Semantic Embeddings to 1536 Dimensions (`src/resolver/semanticSearch.ts`)**:
  - Reverted primary embeddings provider to OpenRouter `text-embedding-3-small` (1,536 dimensions).
  - Created migration `033_revert_vector_1536.sql` altering `gh_candidate_qa_bank.embedding` back to `vector(1536)`, rebuilding HNSW index, and updating `match_candidate_qa` RPC.
  - Added `scripts/reembedQaBankOpenRouter1536.ts` for fast re-embedding.
- **Typecheck & Execution Verified**: `npm run typecheck` passing (0 errors), OpenRouter batch synthesis verified via live API test, and `embedText` output verified at 1,536 dimensions.

## Current Session Update (2026-10-12 — Greenhouse Combobox Backing Input Validation Fix, OTP 8m Budget, Bidirectional Fallback & Sandbox LLM Config)

- **Remix / React-Select Backing Input HTML5 Validation Fix (`src/submitter/liveSubmit.ts`)**:
  - Diagnosed "missing custom field answers" / "complete this job form" form fill failures (e.g. IMC `https://job-boards.eu.greenhouse.io/imc/jobs/4945646101`).
  - Greenhouse Remix comboboxes inject hidden inputs `<input required="" tabindex="-1" aria-hidden="true" class="remix-css-1a0ro4n-requiredInput">` which fail `:invalid` checks even when interactive comboboxes are filled.
  - Excluded hidden React-Select inputs from the HTML5 check: `'input:invalid:not([aria-hidden="true"]):not([tabindex="-1"]), select:invalid, textarea:invalid'`.
- **OTP Budget Extended to 8 Minutes (`src/services/otpResolutionService.ts`)**:
  - Raised `OTP_CHALLENGE_TIMEOUT_MS` from `5 * 60 * 1000` (5m) to `8 * 60 * 1000` (8m) to accommodate slow Greenhouse email delivery.
- **Bidirectional OTP Fallback on `not_yet` / `found: false` / `received: false` (`src/services/otpResolutionService.ts`, `src/services/zoho-connector.ts`)**:
  - Both Gmail and Zoho immediately trigger provider fallback on `not_yet` or missing messages instead of burning the full poll budget on one empty inbox.
- **Sandbox Explicit LLM Provider Override Fix (`src/config/env.ts`, `src/resolver/llmSynthesizer.ts`)**:
  - Fixed hardcoded `LLM_PROVIDER: 'openrouter'` in sandbox config (`isSandboxEnv ? ((process.env.LLM_PROVIDER as ...) || 'openrouter') : rawEnv.LLM_PROVIDER`), allowing runtime flags like `LLM_PROVIDER=gemini` to take effect.
  - Bumped default Gemini synthesizer model from `gemini-1.5-flash` to `gemini-2.5-flash`.
- **Current Blockers / Decisions in Flight**:
  - **OpenRouter Credit Exhaustion**: OpenRouter org credits hit $50.00 spend cap ($0.003 over budget). When using OpenRouter, Tier 3 embedding generation (`text-embedding-3-small`) and Tier 5 batch requests fail with HTTP 402 (`Insufficient credits`), triggering the `[HALT]` pipeline guard. Requires either topping up OpenRouter org balance at `openrouter.ai/credits` or configuring direct embedding/LLM providers.

## Current Session Update (2026-10-11 — Zoho Connected Startup Backfill & End-to-End Ingestion/Submission Filter)

- **Zoho Connected Startup Backfill & Strict Ingestion/Submission Gating Shipped:**
  - **Startup Backfill in Sandbox DB (`src/db/sandboxClient.ts`)**:
    - Added `backfillZohoConnectedProfiles(pool)` executed immediately after `copyProfilesFromDb2(pool)` in `runSandboxMigrations()`.
    - Queries `https://zoho-mail-reader.onrender.com/api/zoho/ui/users`, extracts all connected mailbox emails, resets profiles to `false`, and updates `profiles.zoho_connected = true` for matching `company_email` or `email` (plus demo IDs).
    - Fixed `SandboxQueryBuilder` `.update()` and `.delete()` to return `count: res.rowCount`.
  - **Ingestion Filtering in All Environments (`src/candidate/segregator.ts`)**:
    - Removed `process.env.SANDBOX !== 'true'` check so that candidate segregation enforces the Zoho connection check in sandbox too. Candidates whose profile is not Zoho connected are dropped before producing segments, preventing them from being ingested into `gh_candidate_applications` or resolved.
  - **Status Resolution Robustness (`src/services/zohoConnectionCheck.ts`)**:
    - `resolveZohoConnectionStatuses` now checks both `profile.company_email`, `profile.email`, and pre-flagged `profile.zoho_connected === true`.
  - **Dequeue Submission Guard (`src/db/applications.ts`)**:
    - `getNextQueuedApplicationForRoundRobin` validates `assertApplywizzZohoConnected` before moving an application to `APPLYING`. Disconnected candidates are transitioned to `READY_FOR_REVIEW` with an informative error rather than submitted.
  - **Verified with Vitest**: `tests/zohoConnectedFilter.test.ts` (5/5 tests passing); full 48-test regression suite clean.

## Current Session Update (2026-10-11 — Full 5-Phase Hardening Plan Execution Complete)

- **Completed All 5 Hardening Phases per `salutations.md` with 43/43 Tests Passing (No Git Commits per User Instruction):**
  - **Phase 1: Process Crash Guard (`src/server/crashGuard.ts`, `src/server/index.ts`)**:
    - Process-level `uncaughtException` & `unhandledRejection` handlers intercepting Playwright CDP disconnections (`Target closed`, `Session closed`, `Browser closed`, `WebSocket error`).
    - Startup and shutdown cleanup sweeps transitioning stale `OTP_REQUIRED` / `APPLYING` rows (>10 min old) to `QUEUED`.
    - Verified via `tests/crashGuard.test.ts` (5/5 passing).
  - **Phase 2: Universal Security Code Routing + Company Normalization (`src/services/otpResolutionService.ts`, `src/services/zoho-connector.ts`, `src/submitter/proofCapture.ts`, `src/submitter/liveSubmit.ts`)**:
    - Exported `normalizeCompanyNameForOtp` to strip legal entity suffixes (`Inc.`, `LLC`, `Corp`, etc.).
    - Configured universal routing: all domains (`@gmail.com` and `@applywizard.ai`) call `fetchGmailOtpViaApi` first.
    - Handled `mailbox_not_connected` to immediately trigger Zoho fallback; `not_yet` continues polling Gmail without switching.
    - Implemented `captureJobOtpScreenshot(page, application)` saving `{applicationId}_otp_challenge.png` in `output/proofs/` the moment `detectOTPField` succeeds.
    - Implemented `captureJobFailedScreenshot(page, application, reason)` saving `{applicationId}_failed_{sanitizedReason}.png` in `output/proofs_failed/`.
    - Verified via `tests/otpRouting.test.ts` (12/12 passing).
  - **Phase 3: Form Filler Precision (`src/submitter/formFiller.ts`, `src/submitter/liveSubmit.ts`)**:
    - Fixed `isCountryCodeField` regex to explicitly exclude work authorization and legal eligibility (`/authorized|legally authorized|work authorization|eligible to work|right to work/i`) before the country keyword check.
    - Added `normalizeForCombobox` in `src/submitter/formFiller.ts` to convert curly apostrophes/quotes (`’`, `‘`, `“`, `”`) and en/em dashes before `searchInput.pressSequentially`.
    - Added `applyEducationDegreeFallback` defaulting `Degree*` to `"Bachelor's Degree"` when education is required on DOM and candidate degree is blank.
    - Added `isDemographicOrEeoField` and `resolveEeoFallbackOption` selecting `"Decline to self-identify"` (or first valid option) for mandatory unmapped demographic dropdowns.
    - Added `resolveInvalidFieldLabel` in `detectFormFillingErrors` with container traversal and `aria-labelledby` resolution.
    - Verified via `tests/formFillerPrecision.test.ts` (12/12 passing).
  - **Phase 4: Spinner-Aware Submission Confirmation (`src/submitter/otpSession.ts`)**:
    - Extended `DEFAULT_SUBMISSION_CONFIRMATION_TIMEOUT_MS`: 45s $\to$ 75s.
    - Added `SPINNER_EXTENDED_TIMEOUT_MS`: 90s.
    - Implemented and exported `isSubmitButtonSpinnerActive(page)` inspecting `.loading`, `aria-busy="true"`, `.spinner`, `svg[class*="animate"]`.
    - Integrated spinner detection loop into `verifySubmissionSignals(page, timeoutMs, spinnerExtendedTimeoutMs)`.
    - Verified via `tests/spinnerTimeout.test.ts` (7/7 passing).
  - **Phase 5: Contextual Failure Filenames + Error Message Fix (`src/operator/operatorErrorMessages.ts`, `src/submitter/proofCapture.ts`)**:
    - Added sanitized failure reason embed in screenshot filenames (`{applicationId}_failed_{sanitizedReason}.png`).
    - Added OTP timeout, Gmail security code not found, and mailbox not connected branches before generic `isNetworkError` check in `normalizeOperatorErrorMessage`.
    - Preserved `ECONNREFUSED` generic network error mapping.
    - Verified via `tests/errorMessages.test.ts` (7/7 passing).
  - **Consolidated Verification**: 43/43 unit tests passing, `npm run typecheck` clean (0 errors across src and dashboard). Uncommitted working tree maintained.


- **Comprehensive Diagnosis of 335 RETRY ("Network/429") Applications:**
  - **Identified Root Cause of "Network" Label**: In `src/operator/operatorErrorMessages.ts`, `isNetworkError()` tests `/timed out|timeout/i`. Any OTP retrieval timeout (e.g. `[OTP_FETCH:POLL_BUDGET_EXHAUSTED] Automatic OTP retrieval timed out after 300s`) gets mapped directly to `OperatorErrors.NETWORK`. These were NOT Greenhouse bot blocks or Render 429s!
  - **Actual Event Breakdown**:
    - 178 applications: Zoho UI inbox unreachability (`reason=ZOHO_INBOX_UNAVAILABLE`) under 15 lanes.
    - 97 applications: `reason=GMAIL_OTP_NOT_FOUND`.
    - 46 applications: `reason=POLL_BUDGET_EXHAUSTED`.
    - 14 applications: Playwright navigation/connect timeouts.
- **Deep Investigation of 143 Gmail OTP Failures & Company Name Parameter:**
  - Verified live against `GET /api/gmail/greenhouse-security-code`:
    1. **Disconnected Accounts (~45%)**: Accounts like `vparekh232004@gmail.com` returned `{"found": false, "reason": "mailbox_not_connected"}`.
    2. **Company Parameter Mismatch (~55%)**: Passing raw `application.company_name` (e.g. `"BrightAI Corporation"`, `"Take-Two Interactive Software, Inc."`) causes the API's email subject search to fail against Greenhouse subjects (`"Your BrightAI security code"`), returning `{"found": false, "reason": "not_yet"}` for 300s!
  - **Solution Integrated**: Added legal suffix sanitizer `normalizeCompanyNameForOtp()` (stripping `Inc`, `LLC`, `Corp`, punctuation) + unfiltered fallback (`?email=<email>` without `company`) after 30s.
- **Comprehensive Visual Screenshot Diagnosis Completed:**
  - **Form Fill Failures (80 Apps)**: Opened and inspected screenshots (`cbf766d5` EarnIn, `d4e601aa` RA Capital, `e8948cd4` PitchBook). Identified 4 root causes:
    1. `isCountryCodeField` regex defect: treated work authorization questions containing "country" as phone country dropdowns, attempting to fill "United States" into a ["Yes", "No"] select.
    2. React-Select filter typing: typed raw curly apostrophes (`’` U+2019) into search inputs filtering straight apostrophes (`'`), returning 0 results.
    3. Mandatory Education fallback: when DOM requires Education but candidate profile degree is blank, Degree is left empty (`Degree is required`).
    4. Mandatory EEO: employer-mandated race/demographic dropdowns left unselected.
  - **Confirmation Timeouts (31 Apps)**: Inspected Anthropic and Ceribell screenshots; 100% of jobs had the submit button clicked and actively showing the loading spinner, but the 30-45s timeout expired before Greenhouse backend responded.
  - **Failure Observability & Storage**: Mandatory full-page screenshots before `browser.close()` with sanitized failure reason filenames: `{applicationId}_failed_{sanitizedReason}.png`. Capturing `{applicationId}_otp_required.png` upon challenge detection.
- **Target Performance Contract Defined:**
  - **Requirement 1**: $\ge 80\%$ of all eligible applications resolved accurately.
  - **Requirement 2**: $\ge 90\%$ of resolved applications convert to `APPLIED` + `EMAIL_PROOF_PENDING`.
- **Strategic Blueprint Updated:** `claude_approval.md` updated with full diagnosis, visual evidence, process crash guards, universal OTP routing, company normalization + unfiltered fallback, spinner-aware confirmation (75s), and failure-cause screenshot naming (`{id}_failed_{cause}.png`). Zero code edits made this turn; ready for Claude review.

## Current Session Update (2026-10-11 — 4-Phase Submission Hardening Execution Complete)

- **Completed All 4 Hardening Phases per `blessings.md` with 35/35 Tests Passing:**
  - **Phase 1: SubmitterPool Backpressure & Idle Gating:**
    - Gated `dispatchQueue` and `dispatchOnce` on `getIdleCount() > 0`.
    - Removed unbounded worker lane buffers (`workerQueues[workerIndex]`).
    - Added graceful shutdown recovery reverting all in-flight `APPLYING` applications to `QUEUED` in PostgreSQL and memory on pool stop, SIGINT, or SIGTERM.
    - Verified via `tests/submitterPool.test.ts` (5/5 passing).
  - **Phase 2: OTP Engine: Premature Break Removal, Domain Routing & Token Bucket Rate Limiting:**
    - Implemented token bucket rate limiter singleton in `src/services/mailboxRateLimiter.ts` (3 req/sec cap, queues without dropping).
    - Rate-limited all Zoho and Gmail HTTP fetch requests in `src/services/zoho-connector.ts`.
    - Removed premature `break;` on first `not_yet` response in `src/services/otpResolutionService.ts` — sustained full 300s budget with 4000ms delay.
    - Domain routing: `@applywizard.ai` exclusively to Zoho, `@gmail.com` exclusively to Gmail.
    - Guaranteed cleanup: on budget exhaustion, closes paused session via `clearPausedSession()` and transitions to `RETRY` (or `FAILED` if $\ge 3$) — `OTP_REQUIRED` never persists as a resting state.
    - Verified via `tests/otpResolution.test.ts` (9/9 passing).
  - **Phase 3: Form Filler: Unicode Normalization & Multi-Stage Dropdown Matching:**
    - Added shared `normalizeOptionText()` (straightens curly quotes, en/em dashes, collapses whitespace, trims, lowercases).
    - Implemented 3-stage matching in `matchDropdownOption()`: Stage 1 exact normalized $\to$ Stage 2 prefix/contains $\to$ Stage 3 Fuse.js token-set (threshold 0.35 / similarity $\ge 0.85$). Fail-closed miss logging without picking random options.
    - Integrated multi-stage matching into interactive and native select dropdowns in `src/submitter/formFiller.ts`.
    - Enhanced DOM traversal for `input:invalid` in `src/submitter/liveSubmit.ts` to log full field label, filled value, and options.
    - Verified via `tests/formFillerNormalization.test.ts` (10/10 passing).
  - **Phase 4: Tier 5 Corporate Defaults via LLM Context Injection:**
    - Added `CORPORATE_DEFAULT_PATTERNS` and `getCorporateDefaultHint()` in `src/resolver/tier1Supabase.ts`.
    - Updated `ResolvedField` and `BatchQuestion` types to carry `corporateDefaultHint`.
    - Injected `## Corporate Default Rules` context block in `buildBatchPrompt()` and `buildSinglePrompt()` in `src/resolver/llmSynthesizer.ts`.
    - County derived dynamically from candidate city/state; referral source keyword-priority list enforced.
    - Preserved fail-closed option alignment (`hint != forced answer`).
    - Verified via `tests/corporateDefaults.test.ts` (11/11 passing).
  - **Consolidated Verification:** 35/35 unit tests pass, `npm run typecheck` passes with 0 errors across src and dashboard, and `npm run build` passes cleanly.

## Current Session Update (2026-10-11 - Gmail OTP Integration & Submission Hardening)

- **Gmail Greenhouse Security Code API Integrated:**
  - Implemented `fetchGmailOtpViaApi` in `src/services/zoho-connector.ts` calling `GET /api/gmail/greenhouse-security-code?email=<candidateEmail>&company=<companyName>`.
  - Configured 4s polling with ~800-1900ms live latency and clean failover handling.
  - Set as primary OTP resolver in `src/services/otpResolutionService.ts` with automated fallback to `fetchZohoOtpViaApi` (Zoho inbox).
  - Unit tests (`tests/zohoApiOtp.test.ts`) and TypeScript typecheck (`tsc --noEmit`) passing.
  - Handover file updated at `handover.md` and stats ledger updated at `.ai/stats.md`.

## Current Session Update (2026-10-11 - Auto-Queue Optimization & Resolution Hardening)

- **Auto-Queue Eligibility Elevated to 79.5% (841 / 1,058 applications):**
  - Updated `src/resolver/needsReview.ts` to allow auto-queueing for required fields answered by AI when confidence $\ge 0.8$.
  - Preserved operator review guards: applications hold for review if any required field is unresolved, if an AI required field has confidence $< 0.8$, or if a salary/compensation question was answered negatively ("No", "Decline").
  - Updated unit test suite `tests/autoQueueAndCaNotification.test.ts` to verify the confidence threshold and negative salary gates.
- **Phone Country Resolution & Filling Hardened:**
  - `src/resolver/tier1Supabase.ts`: Resolves country fields (`#country`, `phone_country`, `country_code`) directly from `profile.country` (fallback: parsed country from `profile.location`, default: `"United States"`). If missing, cascades cleanly down the waterfall without blind guessing.
  - `src/submitter/formFiller.ts`: Enhanced phone and country handling to properly select the `#country` dropdown on modern Greenhouse boards (`job-boards.greenhouse.io`), eliminating submission timeouts from unselected phone country errors.
- **Consent & Agreement Checkboxes Mapped:**
  - `src/resolver/tier1Supabase.ts`: Added mapping for standard legal consent and terms checkboxes (including ScaleOps `question_37471261002[]` and Klaviyo `question_37872860002[]`) resolving to `'true'`.
  - `src/submitter/formFiller.ts`: Added a Safety Sweep step to guarantee any mandatory consent/privacy checkboxes on the active DOM are checked before submission, eliminating form fill validation errors.
- **Truth-Grounded LLM Context:**
  - `src/resolver/llmSynthesizer.ts`: Updated `inferYesNoFromProfile()` to default to `"No"` for prior employment / interview history when absent from candidate resume facts, and `"Yes"` for arbitration/terms agreements and hybrid/office presence requirements.


- **Merged & Normalized Dataset:** Consolidated 239 candidate records across 25 sheets of `DASHBOARD CONFIRMATION.xlsx` and `Book1.xlsx`. Stripped operational columns (`Operator`, `Client Name`), replaced placeholder values (`no`, `-`, `n/a`, etc.) with blanks, converted countries to full names (`United States`, `United Kingdom`, `Ireland`, `Australia`), and standardized all locations to Greenhouse-compatible 3-part format: `"{City}, {State/Region}, {Country}"`.
- **Database Synchronization:**
  - Missing profiles handled: Identified 3 profiles missing from `postgres-db2` (`AWL-43949`, `AWL-36115`, `AWL-35184`). Fetched complete JSON records from ApplyWizz API, inserted base rows into `profiles`, and updated with normalized CSV values.
  - Existing profiles updated: Synchronized 237 unique profiles across 7 columns (`phone`, `country`, `country_code`, `location`, `linkedin_url`, `github_url`, `company_email`).
  - Blank preservation: Blank fields in CSV were strictly prevented from overwriting non-null database values. Untouched profile fields (`education`, `work_experience`, `resume_facts`) remained intact.
  - Final database count: 364 total profiles in `postgres-db2`.

## Current Session Update (2026-10-10 - Full Repository Structural Audit)

- **Conducted Performance & Architectural Review:** Completed a full code review using the code-review-and-quality and performance-optimization skills. Findings are logged in Code_Review_Report.md.
- **Identified Major Bottlenecks:**
  1. **Frontend Bloat:** Dual-stack UI with legacy operator-app.jsx (4300+ lines) alongside Vite React. App.tsx lacks code splitting, forcing heavy bundle downloads on all users.
  2. **Playwright CDP Latency:** `for loops sequentially iterating Playwright locators generate severe network round-trips.
  3. **Main Thread Blocking:** `fs.readFileSync used synchronously in Express routes (src/server/index.ts).
  4. **Unbounded Data Fetching:** Administrative list APIs (listAllDashboardUsers, etc.) lack pagination.
  5. **God Files:** src/db/applications.ts and src/server/index.ts exceed 2,000 lines, mixing separate concerns.
  6. **Stale Timestamps & Open RLS:** schema.sql lacks updated_at triggers and leaves core tables open via USING (true).

# Active Context — Current Sprint State

_Last updated: 2026-10-09_

## Current Session Update (2026-10-09 — CAPTCHA Removal Complete)

- **Complete CAPTCHA Codebase Removal ([captcha.md](file:///C:/Users/yaswa/Dev/greehouse_apply/captcha.md)):**
  1. **Active Engine Behavior Eliminated:** Removed `CAPTCHA_SELECTORS`, `detectCaptchaIframe`, and post-submit whole-page text matching (`pageText.includes('security' | 'verify' | 'challenge')`) in `src/submitter/liveSubmit.ts`. Form submission halts now route strictly through standard form validation diagnostics (`SUBMIT_FORM_FILL_ERROR`, `UNRESOLVED_REQUIRED_FIELD`).
  2. **Clean Separation of OTP:** Preserved all automated OTP detection, multi-box filling, resolution, and session management (`otpSession.ts`, `otpResolutionService.ts`).
  3. **Diagnostics & Schema Purged:** Removed `SUBMIT_CAPTCHA_BLOCK` and `SUBMIT_CAPTCHA_AMBIGUOUS` from `FAILURE_DIAGNOSTIC_CATEGORIES` and category mapping. Dropped `CAPTCHA_TIMEOUT` from live database schema `src/db/schema.sql` and ensured forward migration `030_remove_captcha_state.sql` drops `captcha_retry_count` and migrates historical rows to `FAILED`.
  4. **UI & Documentation Cleanup:** Removed legacy captcha states, listeners, and help text from `operator-app.jsx` and related internal comments.
  5. **Regression Tests Updated:** Added test coverage in `tests/submissions.test.ts` verifying that passive reCAPTCHA badges (common on Greenhouse boards) do not divert submissions into challenge handling and that OTP detection operates cleanly. Updated `applicationStats.test.ts`, `autoQueueAndCaNotification.test.ts`, and `candidateQueueFilter.test.ts`. All 24 unit tests pass, and full `npm run typecheck` passes with zero errors.

## Previous Session Update (2026-10-09 — Selective Feature Restoration Completed)

- **Targeted Restoration:** Restored strictly the 4 requested features from the pre-revert state without architectural sprawl:
  1. **Feature 1: Retry Counter:** `retry_count` OTP timeout cycle `0 -> 1 -> 2 -> 3 FAILED` (`MAX_SUBMISSION_RETRIES = 3`) with atomic compare-and-set guards in `updateStatus()` and `enqueueApplication()`. Invalid candidate mailbox fails terminally without burning retries.
  2. **Feature 2: Failure Diagnostics & LLM Telemetry:** `gh_failure_diagnostics` table, migration `029_failure_diagnostics.sql`, automated 90-day background retention cleanup, Dev Dashboard Diagnostics tab with search & pagination, and safe PII-redacted LLM provider telemetry (`getLlmProviderErrorDiagnostics()`).
  3. **Feature 3: Role-Specific Session Expiry:** 8-hour operator ceiling computed from `sessionLoginAt` (`OPERATOR_SESSION_TTL_SECONDS = 28800`), 7-day staff sessions (`STAFF_SESSION_TTL_SECONDS = 604800`), enforced across backend `/api/auth/refresh`, modern `useSession` hook, and legacy `roleAccess.js`.
  4. **Feature 4: Challenge State Deprecation:** Purged `CAPTCHA_REQUIRED` and `CAPTCHA_TIMEOUT` from TypeScript types, schema constraints, Dev/Admin/Operator UIs, and submit routes. Replaced manual challenge endpoints with fast automated OTP flow. Migration `030_remove_captcha_state.sql` created.
- **Strict Boundary Enforced:** **NO mailbox submission lock.** `src/submitter/mailboxSubmissionLock.ts` was deliberately excluded and not created.
- **Pre-Production Checklist:** Created [`PRE_PROD_CHECKLIST.md`](file:///C:/Users/yaswa/Dev/greehouse_apply/to-do/do%20before%20prod/PRE_PROD_CHECKLIST.md) under `to-do/do before prod/` detailing SQL migrations 029 & 030, permission verifications, and pre-flight steps.
- **Verification:** Full TypeScript compilation (`tsc --noEmit && npm run typecheck:dashboard`), production Vite bundle build (`npm run build`), and focused test suites pass cleanly.

## Current Session Update (2026-10-09 — Rollback branch reconstruction)
- Rebuilt the historical `rollback` worktree from the verified `7a35135` baseline without touching the dirty `dev` checkout.
- Created branch `rollback` and committed the recovered run-time tree at `b9b30db` in `C:\Users\yaswa\Dev\rollback-worktree`.
- Preserved the historical typecheck faults and excluded post-run artifacts as required by the rollback plan.

## Previous Session Update (2026-10-08 — Full Codebase Rollback to 7a35135 & Session Conclusion)

- **Complete Revert to Clean Baseline:** Rolled back uncommitted changes from the 2026-10-08 work session via `git restore .` and removed untracked files.
- Codebase state was verified at commit `7a35135`.
- **Environment Key Resolution Fix:** Fixed `src/config/env.ts` so `OPENROUTER_API_KEY` loaded from the repository `.env` file explicitly overrides stale or credit-exhausted keys inherited from the parent Windows shell environment.
- Task-observer observations `0030`, `0031`, and `0032` logged.

## Current Session Update — Sandbox CA Assignment

- Sandbox mode now assigns every profile and application to `yaswanthnaiduyalla@applywizz.ai`, including existing local DB rows normalized at startup and seeded demo data.
- Newly ingested candidates use the sandbox operator email without fetching the external CA map; profile/application upserts and serialized application responses also enforce the sandbox assignment.
- Production CA mapping remains unchanged. Focused regression tests, full typecheck, and production build pass.

## Current Session Update — CI Failure Repair

- Fixed CI failures on `63d33ea`: restored the exported `QuestionLimitExceededError` used by queue/submit callers while keeping the question-count policy unlimited, and corrected the dependent TypeScript narrowing errors.
- Added `tests/sandboxAssignment.test.ts` to the GitHub Actions unit-test command. Local typecheck, production build, and all CI-selected unit tests pass; Docker image build could not be run locally because Docker Desktop is unavailable.

## Current Session Update (2026-10-07 — Question Limit Removal & Submission Gate Audit)

- Removed the 35-question limit cap upon explicit user instruction: `isWithinSubmissionQuestionLimit`, `assertWithinSubmissionQuestionLimit`, and `isWithinSubmissionQuestionLimitForDisplay` in `src/submission/questionLimit.ts` and `isOverQuestionCap` in `src/db/skippedApplications.ts` now permit all applications regardless of question count. Applications will not be skipped or blocked from auto-enqueue or submission due to field count.
- Checked submission eligibility gates: audited the codebase and confirmed that the earlier score eligibility gate (`submissionEligibilityGate.ts` / score 20–60 range) was already completely removed in commit `27eb482`. With the question limit now lifted, there are no remaining score or question gating checks on submission.
- Updated unit tests in `tests/questionLimit.test.ts`. Full typecheck (`npm run typecheck`) and production build (`npm run build`) pass cleanly.

## Current Session Update (2026-10-07 — Auto-queue Routing & CA Notification)

- Implemented safe auto-queue routing at answer resolution time (`src/resolver/answerResolver.ts`): applications where no required field has `source: 'ai'`, `'unresolved'`, or missing source are auto-enqueued directly via `enqueueApplication` (assigns global `submission_order`, sets status `QUEUED`, and emits queue lifecycle event), skipping `READY_FOR_REVIEW`.
- Applications with required fields resolved by AI or left unresolved remain `READY_FOR_REVIEW` for operator review. Applications over the 35-question limit remain `READY_FOR_REVIEW`.
- Re-ingest status preservation: terminal and in-flight statuses (`APPLIED`, `FAILED`, `APPLYING`, `QUEUED`, `OTP_*`, `CAPTCHA_*`, `SKIPPED`, `RETRY`, `EMAIL_PROOF_PENDING`, `DRY_RUN_COMPLETE`, `EXPIRED`) in `RESOLVE_STATUS_PRESERVE` are preserved on re-ingest and never downgraded or overwritten.
- Operator view filtering: `filterOperatorApplicationJobs` excludes `QUEUED` jobs consistently across modern Vite TSX views, legacy `operator-app.jsx`, and candidate job API endpoints (`GET /api/candidates/:id/jobs`, `GET /api/applications`). Other statuses (`READY_FOR_REVIEW`, `SKIPPED`, `FAILED`, `RETRY`, etc.) remain visible.
- Post-ingest CA notification email: added `src/services/caNotificationEmail.ts` and hooked after Phase D in `src/orchestrator/pipeline.ts`. Emails each assigned CA an HTML summary of new `READY_FOR_REVIEW` applications created during the ingest run with client and application counts and link to `https://gh.applywizz.ai`. Supports `CA_NOTIFICATION_EMAIL_OVERRIDE` for sandbox testing. Failure is non-blocking (logs WARN).
- Focused test suite in `tests/autoQueueAndCaNotification.test.ts` and `tests/candidateQueueFilter.test.ts` passed (19 tests). `npm run typecheck` and `npm run build` pass cleanly.

## Current Session Update (2026-10-07 — Docs alignment)

- Reviewed the repo's AGENTS guidance and the active `.ai` record set to confirm the documentation remains aligned with the shipped V2+ state and current sprint notes.
- Kept this pass purely to documentation maintenance: no runtime code, schema, or deployment changes were required during the review.

## Current Session Update (2026-10-07 — Proof screenshot fallback)

- The reported log contains no proof URL/image route requests; its visible errors are missing application-stats migration 027 and `gh_audit_events` RLS, which do not establish the proof failure cause.
- Confirmed a local-storage fallback mismatch: failure screenshots are written under `output/proofs_failed`, while the streaming proxy previously searched only `output/proofs`. The proxy now selects local directories by proof bucket; signed URL, cloud download, and proof-upload errors are logged with bucket/object path, and missing-object responses are logged by the endpoint.
- Added a focused local fallback regression covering web, failure, mail, and dry-run proof buckets. Cloud-storage contents and production endpoint behavior remain unverified from the supplied log; no production data, deployment, or migration was changed.

## Current Session Update (2026-10-07 — Supabase client isolation)

- Storage CSV discovery may probe with the anon key, but no longer replaces the shared DB client. Downloads, audit writes, and stats reads continue through the service-role DB client, preventing RLS-hidden stats configuration and rejected audit inserts after a storage probe.

## Current Session Update (2026-10-07 — OTP body-only extraction)

- OTP lookup still filters inbox messages by Greenhouse sender and security-code subject, but now always fetches the matched message body for code extraction instead of attempting subject extraction first.
- Added a regression test verifying the message-detail endpoint is called and the body code is used even when the subject contains a code-like string.

## Current Session Update (2026-10-07 — Country answer integrity)

- The supplied ingestion log contains no `India` answer; it logs 10 standalone `Country` fields unresolved and excluded from Tier 5.
- Found Tier 1 fallbacks that fabricated India/US country and dialing-code values when profile data was absent, plus candidate-ID overrides. Country fields now prefer `additional_information.zip_or_country`, option-match select/radio fields, and fall through the resolver tiers on mismatch. Country mentions inside other questions are not mistaken for standalone country fields.
- Removed the synthetic country/calling-code defaults from profile normalization and persistence. Existing stored profile values are unchanged until naturally refreshed.
- Historical resolver signals: 57 batch LLM parse errors, 72 `no option match` labels, 91 Tier 4 misses, and 104 Tier 3 below-threshold results (overlapping counts). The old failure logger mislabeled any unresolved choice field as `no option match`; it now reports a neutral unresolved reason, and actual option mismatches are logged only after a concrete answer fails alignment. LLM batch parsing now extracts valid JSON wrapped in prose/fences and still rejects malformed output.
- Added resume-only phone resolution (Tier 2), international prefix stripping, and validation of Tier 3–5 phone answers against the resume. Country Tier 5 receives bounded question-relevant evidence and captured choices; optional standalone Country fields continue through the waterfall too.
- Availability answers now resolve to UTC application date + 7 days, honoring captured native/text date formats; dropdowns use a unique one-week choice or the first choice after “Immediately”. Date metadata is carried through Remix/DOM scan, hydration, and both operator views. Desired-start payload dates no longer leak full dates into month/year component fields; education dates remain month/year-specific.
- UUID-shaped Tier 4 answers are rejected for fields that do not explicitly request identifiers. The three PDF `TT: undefined function: 21` warnings, four expired/scan-failed skips, and 18 zero-job candidate summaries had no verified defect evidence and were left unchanged. Tier 3/4 misses remain fail-closed rather than lowering similarity thresholds. Ingestion reported 200 successful and 344 unsuccessful out of 544 applications, while pipeline status itself was `SUCCESS`.

## Current Session Update (2026-10-07 — Stats availability and score-independent submissions)

- Diagnosed the blank Dev stats cards: migration 027 initializes `available_from` to the next IST day, while its trigger has already recorded current-day events. The dashboard therefore reports the selected date as unavailable and hides those recorded facts.
- Migration 027 now starts availability on the migration day; migration 028 repairs existing installations to the earliest date with captured facts (or today if none exist). It does not reconstruct events from before the trigger was installed; apply migration 028 to the connected database to expose captured facts.
- Removed the configurable score eligibility gate from the submission path, Dev controls/API, and environment config. Any CSV score now proceeds; the hard 35-question limit remains enforced.

## Current Session Update (2026-10-07 — Production stats migration verification)

- Railway logs initially showed that migration 027 was missing, causing stats-backed dashboard API requests to fail. The operator applied it to the connected database; a SQL check confirmed both stats tables exist, `available_from` is `2026-10-08`, and `trg_capture_gh_application_stats` exists.
- The 2026-10-08 availability date left the 2026-10-07 dashboard blank even though same-day facts were captured; migration 028 now corrects this without fabricating pre-trigger history.
- The operator confirmed the production dashboard endpoint now loads after applying 027; the current-day stats tiles still remained unavailable due to the future cutover. The earlier `gh_audit_events` RLS warning was separate and was not verified.

## Current Session Update (2026-10-06 — Canonical Application Statistics)

- Replaced the dashboard metric source with a shared statistics service backed by transactional per-day creation/status-transition facts in migration 027. Admin/Dev, Manager dashboard/operators/reports/overview/stats, and the operator stats API use the same Total/Submitted/Applied/Failed contract while preserving global vs team/CA scope.
- Added explicit pre-cutover unavailability and partial-range behavior; Manager detail panels disclose that retained job/proof rows may be incomplete. Ingestion refuses to prune until migration 027 is installed.
- Focused stats tests, TypeScript checks, and the production build pass. Migration 027 has not been applied: local Docker/Postgres was unavailable, and no production migration or deployment was authorized.

## Current Session Update (2026-10-06 — Apple Music Dark Mode Retheme Across All Dashboards)

- Completed full dark-mode Apple Music visual retheme across modern Vite TSX dashboard components (`App.tsx`, `AdminDashboard.tsx`, `DevDashboard.tsx`, `ManagerDashboard.tsx`, `AuthView.tsx`, `CandidateList.tsx`, `JobQueueView.tsx`, `FormRenderer.tsx`, `EditableFormField.tsx`, `SourceBadge.tsx`, `SubmissionControls.tsx`, `ProofViewer.tsx`, `DifficultyBadge.tsx`, `HeaderSignOut.tsx`, `DevSwitcher.tsx`) and legacy HTML shells (`index.html`, `admin.html`, `dev.html`, `manager.html`, `operator-app.jsx`).
- Design system: `#0a0a0a` (base bg), `#1c1c1e` (surface 1/cards/modals/sidebars), `#2c2c2e` (surface 2/inputs/borders/dividers), `#3a3a3c` (surface 3/glassy pills/input borders), `#8e8e93` (low-contrast/metadata text), `#ffffff` (primary text).
- Status & badges: `#30d158` (APPLIED/QUEUED/APPLYING/approve), `#ff453a` (FAILED/error/unresolved), `#ff9f0a` (OTP/CAPTCHA/SKIPPED/warning), `#0a84ff` (Supabase), `#5ac8fa` (AI), `#0071e3` (Manual), `#30d158`/`#ff9f0a`/`#ff453a` (Difficulty Easy/Med/Hard).
- Zero changes to business logic, routing, endpoints, or data-fetching code. Recompiled Tailwind CSS bundle (`npm run build:dashboard-css`); full typechecks (`npm run typecheck`) and production build (`npm run build`) pass cleanly.

## Current Session Update (2026-10-06 — Operator Dashboard Resolution Metrics)

- Removed the Supabase and AI percentage pills from the TSX operator dashboard header and removed the corresponding cards from its Stats tab.
- The four remaining Stats cards now use a two-column layout. Shared `/api/stats` fields and the legacy operator dashboard are unchanged.
- Dashboard typecheck and production build pass.

## Current Session Update (2026-10-06 — Ingestion Zoho Connection Check)

- After Phase C ensures profiles for CSV candidates, the shared segregator now takes one `/api/zoho/ui/users` snapshot and matches candidate `company_email` values against connected Zoho emails.
- Live true/false statuses are persisted to `profiles.zoho_connected`; connector failures fall back to stored flags, with NULL treated as disconnected. Disconnected candidates remain skipped before resolution.
- The existing `SANDBOX=true` bypass is retained. Focused Zoho status tests, `npm run typecheck`, and `npm run build` pass.

## Current Session Update (2026-10-06 — Profile-Fact Resolution in Tiers 3–4)

- Tier 3 now embeds profile and nested `raw_api_payload` fact labels on demand, checks them before semantic QA-bank lookup, and caches embeddings in process memory without a schema change.
- Tier 4 fuzzy-matches the same candidate facts before its QA-bank fallback; the resolver worker-pool path now runs both tiers in order.
- Added targeted tests for fact extraction, semantic ranking/thresholding, profile-first matching, and QA-bank fallback.

## Current Session Update (2026-10-06 — Incomplete Required Choice Handling)

- Required searchable selects now carry an `optionsComplete` marker from scanning through resolver, application hydration, and dashboard payloads.
- Partial lists are not treated as exhaustive by answer matching or Tier 5 prompts. Required incomplete school/university/college selects use text entry in the operator UI; other incomplete selects keep their captured options visible. Submission still requires a matching, committed live option.
- Added scanner, resolver, and searchable-select regressions; `npm run typecheck`, `npm run build`, and the focused tests pass.

## Current Session Update (2026-10-06 — Required-Only IMC Dropdown Diagnostic)

- Live option enrichment now skips optional choice fields and cascade exploration attempts each required choice field only once when it becomes visible.
- Added and ran `scripts/scanImcJob4908708101.ts`; saved the scan and response diagnostics to `output/imc_job_4908708101_scan.txt`.
- On the IMC posting, School is required. The bounded three-pass scroll captured 100 school entries and marked the list partial; inspected JSON responses did not expose a school-options payload.

## Current Session Update (2026-10-06 — Missing Choice Option Capture)

- The scanner supplements select/radio fields missing Remix choices using native controls or Playwright pointer interaction with Greenhouse custom controls; portaled menu options are supported and existing Remix choices remain authoritative.
- The earlier browser fixture opened its menu on synthetic `click` and kept options inside the field wrapper, so it did not model the reported Greenhouse control. The regression now requires `mousedown` and renders choices in a portal.
- The user confirmed a fresh sandbox scan now persists options for Country, School, Degree, Gender, transgender, ethnicity, Race, Veteran Status, and Disability Status.
- Local browser regression, typecheck, and production build pass; scanner logs now identify visible custom controls whose options could not be captured.

## Current Session Update (2026-10-06 — Direct Admin CSV Upload)

- Added an Admin/dev-only TSX dashboard upload flow that validates supported CSV headers, uploads to the `csv_uploads` bucket with progress, then requires explicit confirmation before ingestion.
- New uploads are staged under `pending/` so the existing latest-pending Start flow cannot ingest them before confirmation; confirmed runs target the exact uploaded object.
- The legacy dashboard fallback and existing Start flow remain unchanged.

## Current Session Update (2026-10-06 — Sandbox Candidate Jobs Loading)

- Candidate detail, job-list, and job-detail read endpoints no longer apply the Zoho-connected-profile gate in local sandbox mode, allowing sandbox records to load without connected mail accounts.
- The Zoho gate remains active in production and on submission routes.

## Current Session Update (2026-10-06 — Sandbox DB Viewer Usability)

- Kept the DB table list at a fixed sidebar width and constrained horizontal/vertical overflow to the results pane so wide rows no longer squeeze it away.
- JSON/JSONB cells now show a compact, single-line summary and expand/collapse on click using native disclosure controls.

## Current Session Update (2026-10-06 — Sandbox Scanned-Template Persistence)

- Fixed sandbox scanning persistence: `exportScannedJobs` no longer invokes Supabase-only `.abortSignal()` on the local PostgreSQL query builder.
- Moved template export outside the non-fatal Playwright scan catch so database write failures are surfaced to the ingest runner.
- Re-exported the existing scan artifact and verified all 10 templates are now in `gh_scanned_job_templates`.

## Current Session Update (2026-10-05 — Role Switcher Persistence & Dev Operator Mode)

- Fixed Dev mode navigation so dev users (`sessionRole() === 'dev'`) can seamlessly switch to Operator mode and return to Dev/Admin/Manager without manual URL editing.
- Persisted `applywizz_dev_operator_view` session flag on the Operator dashboard (`/`), eliminating bounce-back to `/dev` upon page reload.
- Integrated `<DevSwitcher current="/" />` into `dashboard/App.tsx` navigation header for dev users.
- Synchronized `DevSwitcher` click handlers in `DevSwitcher.tsx`, `dev.html`, `admin.html`, and `manager.html` to set the flag when navigating to `/` and clear it when transitioning to `/dev`, `/admin`, or `/manager`.
- Cleaned up session key on user sign-out (`clearSession()` in `useSession.ts` and `roleAccess.js`).
- Verified `npm run build` succeeds cleanly.

## Current Session Update (2026-10-05 — Resolver Correctness Fixes)

- Corrected the diagnosed country, Tier 5 choice-alignment, inferred-option, profile URL, Tier 4 URL, consent, state, degree, and education-date resolution cases.
- Tier 5 now reuses its effective options for final alignment; option-less rich EEOC identity selects remain unresolved instead of receiving fabricated choices.
- Added focused resolver regression coverage; `npm run typecheck` passes.

## Current Session Update (2026-09-26 — Fast REST API OTP Resolution & Submission Hardening)

- **Fast REST API OTP Resolution:** Replaced slow Playwright browser automation for OTP retrieval with direct REST API polling via `fetchZohoOtpViaApi` in `zoho-connector.ts`.
  - Queries `/api/zoho/ui/inbox` and `/api/zoho/ui/message` every 2s for incoming Greenhouse security codes.
  - Slashes OTP retrieval latency from 25–35+ seconds down to 2–5 seconds.
  - Eliminates heavy Playwright browser instances and Chromium memory footprint on Railway.
  - Completely eliminated legacy Playwright `zohoReaderPool` and removed `zohoReader.ts` file. All OTP retrieval and email confirmation proof resolution run exclusively via pure REST API endpoints (`/api/zoho/ui/inbox` and `/api/zoho/ui/message`).
- **Authoritative Operator Decisions:** Made operator-approved `resolved_fields` the primary truth for submission. Forced heuristics (work authorization/relocation defaults, referral sources, country) are relegated to backups that only execute if the field value is empty or unpopulated.
- **Sponsorship Integrity Protected:** Fixed regex in `isWorkAuthRelocation` that matched sponsorship questions. Submitter strictly respects resolved sponsorship choices (clicking "No" when target is "No", never overriding to "Yes").
- **Options Preservation & Hydration:** Updated resolver pipeline (`answerResolver.ts`) to persist `options` on all `ResolvedField` objects (with `['Yes', 'No']` defaults for boolean questions). Added automatic options enrichment in `applicationFieldHydration.ts` for existing database records using template field schemas.
- **Operator Dashboard Enhancements:** Updated `EditableFormField.tsx` and `operator-app.jsx` to display full dropdown options and render contextual hints (e.g., "This is a dropdown question, please choose from the given options.", multi-select hints, location autocomplete hints).
- **Two-Phase Dropdown Resolution:** Hardened `fillInteractiveSelectDropdown` with an exact-match first pass followed by aliased/fuzzy second pass, and updated hidden required-input selector to match Greenhouse `remix-css-*-requiredInput`.

## Current Session Update (2026-09-25)

- Dashboard visual restyling completed:
  - Fixed active dashboard tab text turning white when selected: changed to explicit `text-black` across `dashboard/App.tsx`, `DevDashboard.tsx`, `ManagerDashboard.tsx`, `AdminDashboard.tsx`, and `AuthView.tsx`, and added `nav button, nav button.bg-[#E88474], nav .active, header nav button { color: #000000 !important; }` in `tokens.css`.
  - Removed ALL box shadows across the dashboard: stripped every `shadow-[...]`, `shadow-sm`, `shadow-md`, `shadow-lg`, and `drop-shadow-*` class across all dashboard components (`App.tsx`, `AuthView.tsx`, `CandidateList.tsx`, `JobQueueView.tsx`, `FormRenderer.tsx`, `DifficultyBadge.tsx`, `EditableFormField.tsx`, `EmailProofRenderer.tsx`, `HeaderSignOut.tsx`, `SourceBadge.tsx`, `SubmittingSpinner.tsx`, `SubmissionControls.tsx`, `ProofViewer.tsx`, `DevDashboard.tsx`, `ManagerDashboard.tsx`, `AdminDashboard.tsx`).
  - Removed `--color-shadow` token from `tokens.css` and replaced card shadows with subtle `border: 1px solid #f3f4f6 !important;` (`border-gray-100`).
  - Added global shadow reset in `tokens.css`: `*, *::before, *::after { box-shadow: none !important; --tw-shadow: 0 0 #0000 !important; --tw-shadow-colored: 0 0 #0000 !important; }`.
  - Rebuilt dashboard CSS bundle and verified typechecks and build pass cleanly.

## Docs

- **`OVERVIEW.md`** (repo root, 2026-09-17) — four-perspective analysis (architect / developer / product / critique) with Mermaid diagrams. Not a sprint tracker; use this file for current focus.

## Current Focus

### 0x. Dev Debugger Enhancements (shipped 2026-09-23)
- **Proof Failed Link:** Included `proof_failed_url` in `/api/dev/applications/:id` response. Rendered "Failed screenshot: View" directly after email screenshot links when present in both `dashboard/components/DevDashboard.tsx` and `dashboard/public/dev.html`.
- **Manager Field:** Resolved `manager_email` by querying `gh_users` for the assigned operator (`app.assigned_ca_email`) with fallback to manager linked candidate IDs. Rendered manager email instead of "—" in the Debugger tab.
- **Timeline:** Queried `gh_application_events` for `previous_status, new_status, actor_email, created_at` ordered ascending by `created_at`. Rendered each entry as `"{created_at IST} — {previous_status} → {new_status} (by {actor_email})"`, preserving the fallback message when empty.

### 0w. Manager Home & Operators Metrics Unification (shipped 2026-09-23)
- Unified Home and Operators tabs on the Manager dashboard to pull the same 3 top metrics cards directly from `/api/manager/dashboard`:
  - Total: all non-SKIPPED applications (`status !== 'SKIPPED'`).
  - Submitted: non-SKIPPED applications with `status !== 'READY_FOR_REVIEW'`.
  - Applied: applications with `status === 'APPLIED'` using `submitted_at` falling within the selected date range.
- Removed disparate rollup overrides and separate count queries in `/api/manager/operators`; operators table metrics now aggregate directly from client applications.
- Parity enforced across both TSX (`dashboard/components/ManagerDashboard.tsx`) and legacy HTML (`dashboard/public/manager.html`).

### 0u. Canonical Application Statistics (migration 027 applied; 028 cutover repair pending)
- Migrations `027_application_stats_consistency.sql` and `028_application_stats_cutover_repair.sql` define the availability cutover, transactional application facts, and global/manager/CA scopes; they intentionally do not backfill pre-trigger history.
- `src/db/applicationStats.ts` provides the shared IST date, status, deduplication, scope, and availability contract used by Admin/Dev, Manager dashboard/operators/reports/overview/stats, and `/api/stats`.
- `runStatsRollup()` is now a migration guard before pruning; legacy `gh_stats_rollups` is no longer used by dashboard metric APIs. Apply migration 028 to repair the currently configured future cutover.

### 0t. Answer Resolution Quality Fixes (shipped 2026-09-23)
- **Pre-tier Consent Rule (`answerResolver.ts`):** Added a pre-tier regex match for consent, acknowledge, certify, and agree fields, immediately resolving to the affirmative dropdown/radio option or "Yes" with confidence 1.0.
- **LLM Parse Error Recovery (`llmSynthesizer.ts`, `tier5LLM.ts`):** Wrapped batch JSON parsing in a try/catch block. On failure, the raw output is logged and an array of empty strings is returned instead of crashing the batch. Improved `cleanLLMOutput` with a non-anchored regex to properly strip markdown fences.
- **Option Prefix Matching (`llmSynthesizer.ts`):** Added a 4th fallback mechanism to fuzzy matching. Accepts LLM outputs that strictly match the prefix of exactly one option, heavily increasing resilience for verbose options (e.g. LLM says "Yes" for "Yes, I agree...").
- **Prompt Precision:** Updated batch and single-field system messages to strictly forbid markdown, provide JSON examples, and explicitly command the model to choose exact options.

### 0v. Structured Payload Resolution Context (shipped 2026-09-23)
- Added stable-path T1 payload resolution for compensation, experience, education, preferences, authorization-adjacent form fields, demographics, address, and profile links.
- Tier 5 batch prompts now receive a bounded structured payload context instead of the full raw API payload.

### 0s. Fresh DB Read at Submit Time (shipped 2026-09-22)
- Added fresh `getApplication(applicationId, options.jobUrl || targetUrl)` read in `runLiveSubmit()` (`src/submitter/liveSubmit.ts`) immediately before `fillForm()` is invoked.
- Eliminates the race window where manual edits saved by operators between worker dequeue time and browser form fill were bypassed by the stale in-memory application object.

### 0r. Dashboard Stats Range Unification (in progress 2026-09-22)
- Replacing mixed all-time, rolling Today & Yesterday, and 14/56/180-day dashboard statistics with shared IST `day`, `week`, and `month` presets.
- Summary APIs now accept `range=day|week|month` and use bounded date ranges; manager reports use `submitted_at` and include `EMAIL_PROOF_PENDING` in applied results.
- Typecheck passes. Do not push until the final dashboard diff and production stats behavior are reviewed.

### 0q. Answer Resolver Logging Standardization (shipped 2026-09-22)
- **Standardized Per-Field Resolution Log Format (`answerResolver.ts`):** Unified all per-field logging across Tiers 1–5 in both single-field (`resolveField`) and batch (`resolveJobApplication` / `resolveFieldThroughTier2` / `resolveTier5Batch`) execution paths:
  - Success: `[Resolver] ✅ T{tier} {question_label} → "{answer}"`
  - Failure: `[Resolver] ❌ T{tier} {question_label} — {reason}`
  - Standardized reasons: `no profile match` (T1), `no resume match` (T2), `below similarity threshold ({score})` (T3), `no fuzzy match` (T4), `LLM parse error` (T5), `no option match` (T5), `unresolved` (T5).
- **Stripped Redundant Telemetry & Per-Field Noise:** Removed legacy bullet previews (`• [Source] "label" ➔ "preview"`), verbose tier telemetry, raw payload mining logs, and cascade noise across `answerResolver.ts`, `tier1Supabase.ts`, `semanticSearch.ts`, `tier5LLM.ts`, and `llmSynthesizer.ts`. Preserved pipeline-level summary and progress logs.
- **Exposed Last Semantic Score (`semanticSearch.ts`):** Added `getLastSemanticScore()` tracking top candidate score even when below threshold (`match_threshold: 0.0` RPC probe) for accurate failure log scores.

### 0p. Semantic Search Threshold & Tier 5 Chunk Size Tuning (shipped 2026-09-22)
- **Cosine Similarity Threshold (`semanticSearch.ts`):** Lowered the default threshold in `findSemanticMatch` from `0.88` to `0.82` for broader matching against candidate QA bank entries.
- **Tier 5 Batch Chunk Size (`tier5LLM.ts`):** Reduced `TIER5_BATCH_CHUNK_SIZE` from `15` to `8` fields per LLM call to reduce context length, improve instruction compliance, and avoid output token truncation.

### 0o. Pipeline Stop & Mid-Scan Abort Handling (shipped 2026-09-22)
- **Playwright Scanner Mid-Scan Polling (`playwrightScanner.ts`):** Added `throwIfPipelineAborted('Playwright scan')` immediately after each individual URL completes and page closes, before jitter/next URL.
- **Pipeline Phase B Error Propagation (`pipeline.ts`):** Made Phase B try/catch check `isPipelineAbortedError(err)` and re-throw immediately rather than treating abort as a non-fatal warning. Added `isPipelineStopRequested()` alias to `pipelineAbort.ts`.
- **Stop Endpoint State Synchronization (`adminDashboard.ts`, `server/index.ts`):** `POST /api/admin/stop-ingest` now marks the in-memory run state as `{ running: false, status: 'stopped', finishedAt: ... }` and updates the `ingest_runs` row in Supabase to `status = 'stopped'`, preventing restarted servers or subsequent status polls from reporting stopped runs as still running.

### 0n. Persistent Session Token Refresh Strategy (shipped 2026-09-22)
- **Immediate Page-Load Refresh (`roleAccess.js`):** On page load, `initPageLoadRefresh()` immediately calls `POST /api/auth/refresh` using the stored `applywizz_refresh_token` before any API call fires. All `window.fetch` calls await this refresh before sending requests. If refresh succeeds, rotated tokens are saved to both `sessionStorage` and `localStorage`. If it fails with an invalid/revoked token, `clearSession()` runs and redirects to `/`.
- **60-Minute Periodic Token Rotation (`roleAccess.js`):** Replaced near-expiry checks and 10-minute intervals with an unconditional 60-minute interval (`REFRESH_INTERVAL_MS = 60 * 60 * 1000`) that calls `refreshSession()`, ensuring refresh tokens rotate and never go stale while tabs stay open. Disabled client-side local session expiry cap (`sessionCapExpired() => false`).

### 0m. Tier 1 Resolution Sequence & Pre-Tier Rules (shipped 2026-09-22)
- **Hardcoded Pre-Tier Rules (`answerResolver.ts`):** Fired BEFORE any tier checks (both in `resolveField` and `resolveFieldThroughTier2`):
  - Question label matching `/work\.auth|authorized\.to\.work|eligible\.to\.work/i` resolves directly to `"Yes"` (or `"true"` for checkbox) with source `'supabase'` and confidence `1.0`.
  - Question label matching `/country/i` resolves directly to `"United States"` with source `'supabase'` and confidence `1.0`.
- **Tier 1 Resolution Sequence (`tier1Supabase.ts`):**
  - Order 1: `profiles` columns directly & deterministic policy rules (`resolveStandardProfileAttribute`).
  - Order 2: `profiles.raw_api_payload` JSONB recursive key-value mining (`extractKeyValuePairsFromPayload` + `resolveFromRawApiPayload`). Recursively extracts all top-level and nested primitive keys, normalizing and fuzzy matching with Fuse.js (threshold `<= 0.3`) against the question label before falling through.
  - Order 3: `candidate_qa_bank` by fingerprint.

### 0l. Scanned Job Templates Bulk Upsert Chunking (shipped 2026-09-22)
- **Batched Template Upsert & Timeout (`exportScannedJobs.ts`):** Chunked bulk template upsert into batches of 50 rows with `AbortSignal.timeout(30000)` per batch. Replaced 1-by-1 sequential writes that caused silent stalls during Phase B export. Added per-batch logging: `[Scanner] upserted batch N/total`.

### 0k. Proof Image Rendering & Viewer Resilience (shipped 2026-09-21)
- **Proof URL access:** List, dashboard, and candidate job responses now return raw storage paths; signed URLs are generated only by explicit proof viewer/retrieval routes.
- **Dual-Lookup & Resilient Proof URL Renewal:** Updated `GET /api/applications/:id/proof-url` and `GET /api/applications/:id/proof` to support UUID and candidate ApplyWizz ID + `jobUrl` composite lookup.
- **Server-Side Streaming Proxy (`/api/applications/:id/proof-image`):** Added a first-party binary image streaming proxy with service-role access that bypasses external storage token expiration and CORS restrictions.
- **Multi-Stage Progressive Fallback in ProofViewer:** Updated `dashboard/components/ProofViewer.tsx` and `dashboard/public/operator-app.jsx` with progressive fallback (`initial signed URL` → `refreshed signed URL` → `proxy stream`) and passed `applicationId` and `kind` across `FormRenderer`, `SubmissionControls`, and `JobQueueView`. Eliminated infinite retry loops.

### 0j. Stat & Flow Inconsistencies Hardening (P0, P1, P2 — 2026-09-21)
- **P0-1:** Ownership checks across `applications.ts` and `submissions.ts` are NULL-safe (unassigned applications belong to the open pool and can be submitted by any operator) and perform case-insensitive comparison.
- **P0-2:** Submission 403 displays visible error banner in `operator-app.jsx` and never sets status to `QUEUED`.
- **P0-3:** `DRY_RUN_COMPLETE` retains `Approve & Submit` and action buttons in `operator-app.jsx`.
- **P0-4:** Internal worker routes (`/api/internal/*`) enforce `INTERNAL_API_SECRET` validation via `validateInternalSecret` middleware.
- **P0-5:** `OTP_REQUIRED` and `CAPTCHA_REQUIRED` render dedicated status badges and action panels rather than remapping to `APPLYING`.
- **P1-1:** Standardized canonical status counts across backend and all dashboards (`AdminDashboard.tsx`, `ManagerDashboard.tsx`, `DevDashboard.tsx`, `operator-app.jsx`, and HTML shells). Replaced UI labels "Completed" with "Submitted".
- **P1-2 & P1-3:** Used `submitted_at` for applied metrics; manager and dev dashboards honor requested date ranges.
- **P1-4:** Added divide-by-zero guards on resolution source percentages in Admin overview.
- **P2-1 & P2-2:** Added dedicated `EMAIL_PROOF_PENDING` badge and retry action; enhanced blocked panel with specific guidance for `SKIPPED`, `EXPIRED`, `CAPTCHA_TIMEOUT`, `OTP_REQUIRED`, `CAPTCHA_REQUIRED`.
- **P2-3:** Cleaned non-Greenhouse jobs in Supabase (`READY_FOR_REVIEW` → `SKIPPED`).

### 0i. Submission Flow & Cross-Service Hardening (shipped 2026-09-21)
- **CA Email Pipeline Step & Backfill (`applywizzClient.ts`, `profiles.ts`, `pipeline.ts`, `answerResolver.ts`):** 
  - Added `fetchCaEmailForApplywizzId` and `fetchCaBatchEmailMap` to resolve candidate `careerassociateid` to `ca_email` via CA Management work-history API (`/api/ca/work-history`).
  - Added `upsertProfileCaEmail` in `profiles.ts`.
  - Added Phase B.5 in `pipeline.ts` between Candidate Sync (Phase C) and Resolution (Phase D).
  - Populated `assigned_ca_email` on applications in `answerResolver.ts` and `upsertApplication` in `applications.ts` with memory caching (`profileCaEmailCache`).
  - Admin applications endpoint (`adminDashboard.ts`) left joins `profiles` and displays `assigned_ca_email || profiles.ca_email`.
  - Executed live backfill on `profiles` (294 profiles populated) and `gh_candidate_applications` (876/876 applications now have `assigned_ca_email` populated).
- **URL Allowlist (SEC-4):** Replaced static hostname array with regex `/(^|\.)greenhouse\.io$/i` and exact `grnh.se` match in `submissions.ts`, allowing all subdomains including EU boards (`boards.eu.greenhouse.io`).
- **Proxy Header Forwarding:** `proxyToWorker` forwards `cookie`, `x-view-as`, and `x-view-as-manager-email` (when present) to preserve operator context and session cookies across services.
- **CAPTCHA Session Proxying:** `POST /api/applications/:id/open-captcha-session` runs SEC-4 URL check first, then proxies to `WORKER_SERVICE_URL` so Playwright browser sessions run on the worker service.
- **Cross-Service WebSocket Broadcast:** Added `POST /api/internal/ws-broadcast` on Service 1. Service 3 (worker) forwards status changes and failure alerts via HTTP POST to Service 1 when `WEB_SERVICE_URL` is set, ensuring browser clients connected to Service 1 receive real-time updates. Added `WEB_SERVICE_URL` to `.env.example` and `src/config/env.ts`.
- **Migration 020 (`020_multi_service_state.sql`):** Applied to remote database via Supabase. Tables `ingest_runs`, `system_worker_heartbeats`, `system_config` created with RLS. It historically seeded `submission_eligibility_gate_enabled`; the score-gate setting is now unused. Backfill executed against `gh_candidate_applications`.
- **Worker Submissions & Dry-Run Proxying (`submissions.ts`, `env.ts`, `index.ts`):** `POST /api/applications/:id/submit`, `POST /api/applications/:id/dry-run`, `submit-otp`, and `resume-submission` proxy to `WORKER_SERVICE_URL` via `axios` with auth headers when set. Fallback to local execution if unset. Service 1 logs warning on boot if unset.
- **Applications assigned CA fallback:** `upsertApplication()` in `src/db/applications.ts` populates `assigned_ca_email` from `profiles.ca_email` when missing.
- **Ingest runs tracking:** `src/db/ingestRuns.ts` (`upsertIngestRun`), phase transitions A/B/C/D captured in `storageCsvIngestion.ts` and `src/server/index.ts` on start, completion, failure, and abort.
- **Submitter pool heartbeat & health:** `submitterPool.ts` reports snapshot every 5s to `system_worker_heartbeats` (`service_name = 'submitter_pool'`), updates status to `stopped` on SIGTERM/SIGINT. `healthSnapshot.ts` queries `system_worker_heartbeats` for worker pool status.
- **Admin Ingest Status Guard:** `adminDashboard.ts` queries `ingest_runs` and `src/server/index.ts` allows authenticated operators to read `GET /api/admin/ingest-status`.
- **Submission question limit:** CSV job score is not an eligibility condition. `src/submission/questionLimit.ts` enforces the existing 35-question cap.
- **Candidate listing:** `src/server/index.ts` derives `resumeAvailable` from `profiles.resume_storage_path` and removes V1 artifact fallback.
- **Manager client dashboard:** `clientDashboard.ts` team scoping includes candidates whose profiles match manager team CAs.
- **Internal worker routes:** When `ENABLE_QUEUE_WORKER=true` in `src/server/index.ts`, mounted `POST /api/internal/applications/:id/submit-otp`, `POST /api/internal/applications/:id/resume-submission`, and `GET /api/internal/worker-status`.

### 0g. Security, Reliability & Performance Hardening (shipped 2026-09-21)
- **Security:** SEC-1 & SEC-2 auth bypass test gate (`requireRole.ts`), SEC-3 IDOR ownership verification (`applications.ts`), SEC-4 SSRF URL validation (`liveSubmit.ts`), SEC-5 `JWT_SECRET` safe fallback default + prod warning log (`env.ts`), SEC-8 CORS origin restriction (`server/index.ts`), SEC-6 safe MFA QR data-URI rendering (`AuthView.tsx`, `index.html`), SEC-9 session storage token migration (`roleAccess.js`), SEC-10 CSP meta tags across all HTML shells (`index.html`, `manager.html`, `admin.html`, `dev.html`).
- **Race Conditions:** RACE-1 TOCTOU claim check (`queueWorker.ts`), RACE-3 proof capture error isolation preserving `APPLIED` (`liveSubmit.ts`).
- **Reliability:** RELIABILITY-1 30-min session TTL on paused CAPTCHA/OTP sessions (`captchaResume.ts`, `liveSubmit.ts`), RELIABILITY-2 LLM error classification and typed failure bubble in Tier 5 (`tier5LLM.ts`), QUALITY-1 masked internal server errors on 500 HTTP responses (`applications.ts`, `submissions.ts`).
- **Performance:** PERF-1 5MB PDF size guard (`tier2ResumeParse.ts`), PERF-2 per-URL page lifecycle in scanner (`playwrightScanner.ts`), PERF-3 database query pushdown (`manager.ts`, `devDashboard.ts`), PERF-4 adaptive polling interval (`App.tsx`, `operator-app.jsx`), PERF-5 LRUCache capped at 5000 entries for embeddings (`semanticSearch.ts`).

### 0f. GitHub Actions CI & Worker Service Isolation (shipped 2026-09-20)
- **CI Pipeline (`.github/workflows/ci.yml`):** Runs on push to `main` and feature/fix/hotfix branches, and PRs to `main`. Multi-job waterfall: `typecheck` (`npm run typecheck`) → `build` (`npm run build` + server boot smoke check) → `test` (`npm test`, non-blocking via `continue-on-error: true`). Includes PR failure comments and README status badge.
- **Zoho Reader Service Isolation:** In `src/server/index.ts`, `zohoReader.init()` is gated on `ENABLE_QUEUE_WORKER === 'true'`. Worker Service (Service 2) runs background Zoho session; Web Service (Service 1) and Ingest Service (Service 3) skip launch cleanly with a log notice.
- **Dev Operator View (`applywizz_dev_operator_view`):** DevSwitcher in `dev.html` sets session key before navigating to `/`; `App.tsx` respects session key on mount so dev users can view the operator dashboard without being bounced to `/dev`.

### 0e. Dashboard UI: bundled TSX parity (shipped 2026-09-21)
- **Serving:** Dual-mode via `DASHBOARD_MODE` ('tsx' vs 'html'). In 'tsx' mode: serves `dist/client` static bundle; `GET /` serves `dist/client/index.html`; `GET /fallback` serves legacy `dashboard/public/index.html`. `GET /admin`, `/dev`, `/manager` serve `dist/client/{admin,dev,manager}/index.html` with fallbacks under `GET /{admin,dev,manager}/fallback`. `DASHBOARD_MODE=tsx` set on Railway Service.
- **Production Status:** Verified live on `https://gh.applywizz.ai`. Resolved Railway service variable drift (`INGEST_ONLY=true` removed from primary `greehouse_apply` service and `ALLOWED_ORIGINS` configured). All dashboard routes (`/`, `/admin`, `/dev`, `/manager`) return 200 OK.
- **Build:** Vite 6 multi-entry build (`vite.config.ts`) targets `dist/client` with `@vitejs/plugin-react` (`npm run build:dashboard` / `vite build`, `npm run dev:dashboard`). Root `build` is `tsc && vite build`.
- **Dashboards:** Operator (`App.tsx`), Manager (`components/ManagerDashboard.tsx`), Admin (`components/AdminDashboard.tsx`), Developer (`components/DevDashboard.tsx`), all with hook-based auth (`useRequireRole` in `useSession.ts`).

### 0a. Admin ingest status bar — shipped on **Overview** (corrected 2026-09-18)
- **Actual state:** the bar sits at the **top of the Overview tab**, above the stat cards — **not** on **System**. It holds the dashboard's only **▶ Start** / ** Stop** controls (the header has none; the Guide tab's "Header: Date, Refresh, Start, Stop" heading is stale) and carries the ids **`ingestStatusBar`**, **`ingestStatusText`**, **`ingestStartBtn`**, **`ingestStopBtn`**.
- **States:** idle · running · failed · finished, with `animate-pulse` while running. `GET /api/admin/ingest-status` returns `running`, `startedAt`, `finishedAt`, `processedCount`, `processedFile`, `message`, `error`, `phase`, plus `stopEnabled`.
- **One poller only:** the 3 s `/api/admin/ingest-status` poll in `admin.html` (`refresh()` also reads it every 30 s); a 60 s effect resets failed/finished back to idle. **System** shows a text-only `Ingest:` line.
- **Superseded (never built):** a dedicated System-tab bar and/or sticky header bar. Do not add a second bar, a second poller, or a second clear timer.

### 0c. Parallel resolve + batched Tier 5 + ingest stop (shipped `56d5270`)
- **`resolveJobApplication`:** Tier 1–2 per field, then Tier 5 in chunks of 15 via `resolveTier5Batch` + `finalizeRawAnswer` (options fail-closed, qa_bank writeback).
- **`resolveAllApplications`:** `RESOLVER_WORKER_POOL_SIZE` (default 3) parallel workers; abort between jobs.
- **Stop:** `isPipelineStopEnabled()` true on Railway; admin header polls ingest-status on all tabs; **Stop** visible while `running`.

### 0b. Pipeline compact progress logs (local — deploy with next push)
- **Playwright:** `[Playwright Scanner] progress N/M …` every 100 URLs or 120s in compact mode (plus existing `scan complete`).
- **Pipeline:** `[Pipeline] phase A/B/C/D …` one-liners in compact mode; **Storage CSV Ingestion** `pipeline start` / existing `pipeline complete`.

### 0d. Dashboard role + candidate hydration (shipped `3b42135`)
- **`resolveRoleFromRequest`:** same precedence as sign-in (`resolveEffectiveAppRole`) so dev email map wins over JWT `app_metadata.operator`.
- **`GET /api/candidates`:** unrestricted roles supplement list from `distinctApplywizzIdsForCreatedAtRange`; skip `zoho_connected_profiles` filter when unrestricted.
- **Manager team scope:** union work-history + **`applywizzIdsForManagerTeamProfiles`** + DB operator emails.

### 0. Admin / manager dashboard metrics (local — ship after upcoming fixes)
- **`GET /api/admin/managers`** — `adminManagerStats.ts` (operators / clients / apps / 48h active), not date-scoped client rollup.
- **Operator workload** — `countOperatorWorkloadByProfileCaEmail()` on admin + manager `GET /operators`.
- **UI (display only)** — `admin.html` managers + operators + applications operator column; `manager.html` workload + enriched Activity lines.
- **Manager stats fix (2026-09-21):** Operators now derives Assigned/Completed/Applied from the same scoped dashboard rollup as Home instead of separate today-only count queries; operator API errors are surfaced in both Manager UI implementations. Activity accepts the selected date range, and Reports uses period-scoped assigned counts. Typecheck/build pass; non-E2E suite still has unrelated environment-dependent failures in existing resolver/submission tests.
- **Worker/ingest split follow-up (2026-09-21):** `/api/stats` now applies the selected date range to outcome, completed, and applied counts from Supabase. Operator field edits no longer require assignment ownership (auth and role guards remain), and assignment email checks are case-insensitive for submission. Failed, dry-run-complete, and email-unverified applications remain editable/submittable for operator retry flows.
- **Next:** finish remaining changes, then commit + deploy; smoke `/admin` Managers/Operators/Applications and `/manager` Operators/Activity.

### 1. Role from `users.role` (shipped — re-login to refresh JWT)
- Sign-in: `resolveSignInRoleForEmail` — `ROLE_BY_EMAIL` override → `users.role` → `operator`; persists JWT `app_metadata.role` + `users` upsert.
- Requests: `resolveEffectiveAppRole` — map override → JWT claim (no per-request DB read).
- Signup: existing `users` row bypasses CA emails API gate (`isEmailAuthorizedForSignup`).

### 2. Manager view-as operator / Ops mode (shipped)
- Manager JWT + header **`X-View-As: operator`** on candidate list/jobs, **`/api/applications`**, **`/api/notifications`**: team-scoped via `profiles.ca_email` for operators where `users.manager_email` = manager.
- **Dev ops mode:** same scope when dev sends **`X-View-As-Manager-Email`** (manager picker on `/manager`); unrestricted dev access unchanged without ops flags.
- **UI:** **`/manager` → Ops mode** (manager confirm; dev picks manager) → `/` with session flags; operator banner + **Back to manager mode**; `roleAccess.js` sends headers on authed fetches.
- **`requireOperatorDashboardAccess`:** operator, dev, or manager + view-as header on operator API routes.
- Response header **`X-View-As-Active: true`** when branch active.
- **Candidate jobs scope (shipped `5b70d04`):** **`resolveDashboardCandidateAccess`** on list + per-candidate routes (date query aligned); profile/WH detail hydration; **`applicationAssignedCaAllowedForRequest`**; scoped sidebar **`job_count`**; **`dateQuery`** on detail + single-job fetch; operator list WH fallback unified.

### 2b. Admin operators by manager (shipped)
- **`GET /api/admin/operators?manager=`** filters via **`users.manager_email`** (`listOperatorEmailsForManager`), not date-scoped client dashboard rows. Response includes **`managerEmail`** per operator when mapped.

### 3. Manager CA / team filtering (shipped — verify in prod)
- **`users.manager_email`** populated on operator login via work-history + CA manager UUID map (migration **017**).
- **`MANAGER_TEAM_SCOPE_ENABLED = true`**: manager dashboard + `GET /api/candidates`, `/jobs`, `/stats`, **`GET /api/users`** scoped to operators where `manager_email =` signed-in manager.
- Dev/admin see all; dev bypasses role guards as before.
- **Next:** confirm operators have `manager_email` after login; smoke-test manager `/manager` and any shared list APIs.
- **Sign-in audit logs (shipped):** every login logs `[Auth]` upsert `{ data, error }`, manager-mapping gate, WH CA manager id + map outcome; mapping skipped if upsert fails; try multiple candidates for manager id.

### 4. Submission question limit
- CSV score never blocks queueing or live submission; the removed Dev toggle/API and `SUBMISSION_ELIGIBILITY_GATE_ENABLED` setting are obsolete.
- `MAX_JOB_QUESTIONS=35` remains the hard cap: jobs with 35+ scanned fields are skipped, and submission rejects records with a missing or over-limit count.

### 5. Resolution engine
- Production 5-tier waterfall: Tier 1 (Supabase QA/profile) → Tier 2 (Resume parse) → Tier 3 (Semantic vector search via `semanticSearch.ts`) → Tier 4 (Fuse.js fuzzy match via `tier3FuzzyMatch.ts`) → Tier 5 (Batched LLM synthesis via `tier5LLM.ts`).
- **2026-09-19 updates:**
  - `semanticSearch.ts` wired as Tier 3 (`findSemanticMatch`, OpenRouter `text-embedding-3-small`, threshold 0.88) with startup key detection.
  - `writeEmbedding` wired into Tier 5 writebacks (`resolveTier5` and `resolveTier5Batch`) for instant candidate QA bank vector indexing.
  - `synthesizeBatchAnswers` includes candidate profile context block.
  - `finalizeLlmAnswer` includes 3-step fuzzy option fallback (normalized comparison, contains check for short options, Fuse.js threshold 0.85) before hard reject on choice fields.

## Immediate Blockers / Open Questions
- Apply migration 028 to production so same-day captured facts are eligible for dashboard queries. PostgreSQL validation and production migration/deployment have not been performed in this session.
- Operator-triggered retry is implemented locally; verify the retry button and atomic `FAILED` → `QUEUED` transition in operator smoke testing.
- **Open question (2026-09-18):** `GET /api/manager/reports` `perOperator[].apps` is an **all-time** count (spec gave it no date predicate) while `applications` / `completed` / `approved` in the same object are **period-scoped** — confirm whether `apps` was meant to be period-scoped too; it will read as inconsistent next to its neighbours in any UI built on it — now rendered in the Reports per-operator table, so the mismatch is user-visible.

## Recent Decisions Made
- Manager team scope uses **`users.manager_email` → operator emails → `assigned_ca_email` / work-history union**, not ApplyWizz `careerassociatemanager_id` API alone.
- Operator queue shows **all** application rows (including SKIPPED); blocked statuses use operator-friendly **`error_message`** in the form panel.
- Default dashboard date window: **Today & Yesterday** (IST) unless `?from=&to=` override.
- **`candidate_applications` upsert timing:** no pre-resolve rows from segregator / `ensureApplicationRowsFromCsv`; resolver upserts only when at least one resolved field has a non-empty value (SKIPPED over-cap excepted).
- **AI ops:** Railway + Supabase investigations/deploy checks use **MCP**, not CLI (documented in `AGENTS.md` + `.ai/techContext.md`).
- **Prod crash fix (2026-09-16):** `X-Dashboard-Date-Range` must be visible ASCII — custom range labels use `-` not en-dash; `sanitizeHttpHeaderValue()` on `GET /api/candidates`.
- **Application timeline writes:** `enqueueApplication` fires a fire-and-forget `application_events` insert (`previousStatus → QUEUED`, actor = assigned CA) in the success branch of the Supabase queue update (mirrors `updateStatus`); verified present in the patch tree 2026-09-18 — do not add a second copy. `getNextQueuedApplicationForRoundRobin()` now also writes the `QUEUED → APPLYING` event, in **both** dequeue branches (RPC + fallback), via a **static** `insertApplicationEvent` import — the lazy `await import` convention used twice elsewhere in the same file was rejected there because the RPC branch's `try` falls through to the fallback query on throw, so a new throw point would double-dequeue (see observation 0017).
- **Reports Applied column (2026-09-18):** manager.html-only change — per-operator **Approved** column replaced with a clickable **Applied** count + applied-jobs modal; modal data composed client-side from `GET /api/manager/dashboard` (`completedApplications[]` where `status === 'APPLIED'`, hydrated proofs) over the same window `/reports` buckets use (daily=14d / weekly=56d / monthly=180d). `perOperator[].approved` is still returned by the API but intentionally unrendered; if `/reports` later gains applied data, replace the client-side composition (see `manager.html` `loadReports` comment).
