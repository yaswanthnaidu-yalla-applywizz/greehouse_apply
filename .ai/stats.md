# Greenhouse Automation Sandbox Run Stats Ledger

This file tracks every sandbox run's metrics, configuration, code changes, and application breakdown.

---

## Run 1: Baseline Architecture Hardening Run
- **Timestamp**: 2026-10-11
- **Configuration**:
  - `SUBMISSION_POOL_SIZE`: 15
  - `RESOLVER_WORKER_POOL_SIZE`: 8
  - `WORKER_POOL_SIZE` (Scanners): 20
  - Mode: `SANDBOX=true`, `ENABLE_QUEUE_WORKER=true`, `DASHBOARD_MODE=tsx`
- **Code Changes Made**:
  1. `src/resolver/tier1Supabase.ts`:
     - Added `getDegreeSubjects` to tokenize subjects by comma, `or`, `and`, and strip trailing clauses (`"or related field"`).
     - Search all degrees in candidate history.
     - On miss, return `null` instead of `'No'` to allow full downstream cascade to Resume, Semantic, and LLM tiers.
  2. `src/resolver/answerResolver.ts`:
     - Removed lines 436–450 early return for optional fields; all fields cascade through Tiers 1–5.
     - Added School combobox exception in choice alignment so lazy-loaded university options are not rejected as choice options.
  3. `src/submitter/formFiller.ts`:
     - Refined explicit Education section rule (`isExplicitEducationField` & `isEducationSectionRequiredOnDom`): if the section is optional on the DOM and candidate data is incomplete, leave the section completely untouched to avoid triggering validation errors.
     - Dynamic school combobox fallback: types candidate institution, waits for network autocomplete, selects top suggestion or presses Enter.
  4. `src/submitter/liveSubmit.ts` & `src/submitter/submitterPool.ts`:
     - Transitions status to `EMAIL_PROOF_PENDING` upon web submit confirmation and releases worker lane immediately (~25–35s runtime per application).
     - Added 1500ms startup launch delay jitter between workers in `SubmitterPool` to eliminate CPU/network contention.
  5. `src/db/applications.ts`:
     - `recoverStaleApplyingApplications` reclaims expired `APPLYING` worker leases directly to `QUEUED` instead of failing to `RETRY`.
  6. `scripts/reconcile_email_proofs.ts`:
     - Added parallel batch reconciliation script querying Zoho REST `/api/zoho/ui/inbox` across candidate mailboxes to promote `EMAIL_PROOF_PENDING` $\to$ `APPLIED`.
- **Target Metric**: $\ge 80\%$ applied rate (`APPLIED` + `EMAIL_PROOF_PENDING`) out of auto-queued applications.
- **Stage & Status Breakdown**:
  - **Stage**: Processes Stopped (Run 1 Halted by Operator).
  - **Total Applications Generated**: 1,058
  - **Applied / Successful Submissions**:
    - `APPLIED`: 58
    - `EMAIL_PROOF_PENDING`: 29
    - **Total Successful Applied**: 87
  - **In-Flight Remaining**:
    - `APPLYING`: 312
    - `QUEUED`: 1
  - **Held in Review / OTP**:
    - `READY_FOR_REVIEW`: 266 (held due to genuine data gaps: missing resume in CRM)
    - `OTP_REQUIRED`: 214 (Greenhouse email verification OTP challenge)
  - **Retries & Failures**:
    - `RETRY`: 130
    - `FAILED`: 48
- **Effectiveness Analysis of Fixes**:
  1. **Worker Lease Expiration (`"Submission worker lease expired while applying"`)**:
     - **Before**: 51+ applications killed with lease expiration.
     - **Now**: **0 lease expiration errors**. Decoupling worker lanes upon web confirmation screenshot eliminated the 10-minute inline hold.
  2. **Education Section Validation Errors**:
     - **Before**: Mandatory dynamic Education dropdowns (`School*`, `Degree*`, `Discipline*`) left blank caused 51 form validation failures.
     - **Now**: **0 School/Degree/Discipline required field errors**. Unrequired education sections were cleanly bypassed, and lazy-loaded school comboboxes completed.
  3. **Waterfall Fall-Through & Qualification Heuristics**:
     - Verified: Multi-subject questions (`question_18896285008`) and unrequired fields no longer short-circuit at Tier 1 and cascade to Tiers 2–5.
  4. **Primary Remaining Bottlenecks**:
     - **OTP Email Fetch Timeouts (`SUBMIT_OTP_TIMEOUT`: 412 attempts, 214 currently in `OTP_REQUIRED`)**: Greenhouse sends email verification codes to candidate Zoho mailboxes; mailbox lookup took longer than the wait budget or hit rate limits under 15 parallel workers.
     - **Candidate CRM Data Gaps (`READY_FOR_REVIEW`: 266, `FAILED`: 48)**: Candidates lacking resumes or having broken/403 S3 URLs in ApplyWizz CRM.

---

## Code Update: Gmail Greenhouse Security Code Integration
- **Timestamp**: 2026-10-11
- **Target Bottleneck**: OTP resolution timeouts (`SUBMIT_OTP_TIMEOUT`, 214 applications in `OTP_REQUIRED`).
- **Code Changes Made**:
  1. `src/services/zoho-connector.ts`:
     - Added `fetchGmailOtpViaApi(options: GmailOtpApiQueryOptions): Promise<ZohoOtpApiResult>`.
     - Queries `GET /api/gmail/greenhouse-security-code?email=<candidateEmail>&company=<companyName>`.
     - Benchmarked endpoint latency (~800ms–1900ms per request) and verified error payload formats (`{"found":false,"reason":"not_yet"}`).
     - Safe polling interval set to 4000ms with a 30s–60s budget per cycle.
  2. `src/services/otpResolutionService.ts`:
     - Integrated `fetchGmailOtpViaApi` as primary OTP retrieval mechanism in `attemptResolutionCycle`.
     - Retains seamless fallback to `fetchZohoOtpViaApi` if the Gmail endpoint returns `found: false` or times out.
  3. `tests/zohoApiOtp.test.ts`:
     - Added unit tests for `fetchGmailOtpViaApi` verifying parameter passing, JSON response handling, and OTP extraction. All 7 unit tests passing.
  4. `scripts/test_gmail_otp.ts`:
     - Added verification script testing real candidates against the live endpoint.


---

## Run 2: Fresh Sandbox Full Pipeline Execution (`npm run sandbox:fresh`)
- **Timestamp**: 2026-10-11
- **Configuration**:
  - `SUBMISSION_POOL_SIZE`: 15
  - `RESOLVER_WORKER_POOL_SIZE`: 8
  - `WORKER_POOL_SIZE` (Scanners): 20
  - Command: `npm run sandbox:fresh` (`cross-env SANDBOX=true ENABLE_QUEUE_WORKER=true DASHBOARD_MODE=tsx`)
- **Code Changes Applied Before Run 2**:
  1. `src/submitter/queueWorker.ts`:
     - Wired `otpResolutionService.start()` into `SubmissionQueueDaemon.start()` so OTP resolution service runs in standalone daemons.
  2. `src/submitter/liveSubmit.ts`:
     - Updated candidate email retrieval to use whatever is configured on `profile.company_email` or `profile.email` without domain filtering restrictions.
- **Stage**: Halted by Operator for Root Cause Diagnosis.
- **Total Applications Generated**: 1,058
- **Audited Database Status Breakdown**:
  - `APPLYING`: 562 (Stranded due to SubmitterPool backpressure bug draining DB queue into memory)
  - `READY_FOR_REVIEW`: 265 (253 missing corporate trivia/unresolved required fields, 16 negative salary answers)
  - `OTP_REQUIRED`: 90 (67 `@applywizard.ai` Zoho, 23 `@gmail.com`; killed early due to loop `break;` at $t=30$s)
  - `RETRY`: 56 (36 HTML5 validation errors from Unicode quote mismatch/Select..., 12 HTTP 429/500, 8 timeouts)
  - `EMAIL_PROOF_PENDING`: 37 (Web confirmation achieved, waiting for Zoho confirmation mail delivery)
  - `APPLIED`: 36 (Full web submit + confirmation proof verified)
  - `FAILED`: 12 (Hard Greenhouse in-page application rejection banners)
- **Total Successful Applications**: **73** (`36 APPLIED` + `37 EMAIL_PROOF_PENDING`) (6.9% of total 1,058, 9.2% of 793 attempted).
- **Root Causes Diagnosed**:
  1. **SubmitterPool Backpressure Defect**: `dispatchQueue()` in `submitterPool.ts` loops infinitely without `getIdleCount() > 0` check. It dequeued from PostgreSQL into in-memory worker buffers and updated DB status `QUEUED -> APPLYING` within 2 seconds. When halted, 562 applications were left stranded in `APPLYING`.
  2. **OTP Premature Loop Abort**: In `otpResolutionService.ts` line 229, an unconditional `break;` on the first poll miss aborts the 5-minute wait loop after 30 seconds. This kills Chromium and abandons applications in `OTP_REQUIRED`. Additionally, 67 `@applywizard.ai` mailboxes are routed to the Gmail API first, wasting 30 seconds before falling back to Zoho.
  3. **Form Filler Option Mismatch**: `formFiller.ts` exact-match comparison fails on Unicode curly apostrophes (`Master’s Degree` vs `Master's Degree`) and verbose sentence options, leaving dropdowns on `Select...` and failing HTML5 validation (56 `RETRY` apps).
  4. **Phase D Waterfall Fail-Closed**: 253 applications were held in operator review because corporate trivia questions ("Have you interviewed here before?", "How did you hear about us?", arbitration/AI policy agreements, "County") lack resume context and Tier 5 returns unresolved.
- **Comprehensive Plan**: Documented in `claude_approval.md` for team alignment before code execution.

