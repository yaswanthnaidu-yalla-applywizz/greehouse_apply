# Active Context — Current Sprint State

_Last updated: 2026-09-22_

## Current Session Update (2026-09-23)

- Form submission hardening completed: visible failed fields are re-attempted after cascade expansion, number inputs use DOM value assignment, date-year inputs accept explicit aria-label selectors, and retry queue `submission_order` no longer receives millisecond timestamps.

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

### 0u. Stats Rollup System (shipped 2026-09-23)
- Implemented `runStatsRollup` (`src/db/statsRollup.ts`) and `024_stats_rollups.sql` migration.
- Automatically calculates daily, weekly, and monthly aggregate counts (Total, Submitted, Applied, Failed) and prunes previous days' historical `gh_candidate_applications` and `gh_scanned_job_templates`.
- Wired into ingestion pipeline step before Phase A.
- `/api/admin/overview`, `/api/manager/dashboard`, and `/api/stats` were updated to read aggregated results via `queryRollupStats` combined with unrolled live rows for blazing fast UI analytics.

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
- **Candidate Job Proof Hydration:** Added `hydrateApplicationProofUrls(row)` to `GET /api/candidates/:applywizzId/jobs/*` so operators always receive fresh valid signed URLs up front.
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
- **Migration 020 (`020_multi_service_state.sql`):** Applied to remote database via Supabase. Tables `ingest_runs`, `system_worker_heartbeats`, `system_config` created with RLS. Seeded `submission_eligibility_gate_enabled = true`. Backfill executed against `gh_candidate_applications`.
- **Worker Submissions & Dry-Run Proxying (`submissions.ts`, `env.ts`, `index.ts`):** `POST /api/applications/:id/submit`, `POST /api/applications/:id/dry-run`, `submit-otp`, and `resume-submission` proxy to `WORKER_SERVICE_URL` via `axios` with auth headers when set. Fallback to local execution if unset. Service 1 logs warning on boot if unset.
- **Applications assigned CA fallback:** `upsertApplication()` in `src/db/applications.ts` populates `assigned_ca_email` from `profiles.ca_email` when missing.
- **Ingest runs tracking:** `src/db/ingestRuns.ts` (`upsertIngestRun`), phase transitions A/B/C/D captured in `storageCsvIngestion.ts` and `src/server/index.ts` on start, completion, failure, and abort.
- **Submitter pool heartbeat & health:** `submitterPool.ts` reports snapshot every 5s to `system_worker_heartbeats` (`service_name = 'submitter_pool'`), updates status to `stopped` on SIGTERM/SIGINT. `healthSnapshot.ts` queries `system_worker_heartbeats` for worker pool status.
- **Admin Ingest Status Guard:** `adminDashboard.ts` queries `ingest_runs` and `src/server/index.ts` allows authenticated operators to read `GET /api/admin/ingest-status`.
- **Submission eligibility gate:** `devDashboard.ts` reads/writes `system_config`. `src/server/runtimeState.ts` and `src/submission/submissionEligibilityGate.ts` read `submission_eligibility_gate_enabled` from `system_config` with a 15s in-memory TTL.
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

### 4. Submission eligibility gate (shipped — local)
- Ingest/segregator keeps **all** CSV scores; resolver runs for all templates (incl. ≥35 fields); `csv_job_score` + `field_count` on apps (migration **019**).
- **Gate ON** (default): only score 20–60 and `< MAX_JOB_QUESTIONS` fields may queue/live-submit. Toggle on **Dev → System** (`PATCH /api/dev/submission-gate`); operator dashboard shows all jobs + `eligibleForSubmission`.

### 5. Resolution engine
- Production 5-tier waterfall: Tier 1 (Supabase QA/profile) → Tier 2 (Resume parse) → Tier 3 (Semantic vector search via `semanticSearch.ts`) → Tier 4 (Fuse.js fuzzy match via `tier3FuzzyMatch.ts`) → Tier 5 (Batched LLM synthesis via `tier5LLM.ts`).
- **2026-09-19 updates:**
  - `semanticSearch.ts` wired as Tier 3 (`findSemanticMatch`, OpenRouter `text-embedding-3-small`, threshold 0.88) with startup key detection.
  - `writeEmbedding` wired into Tier 5 writebacks (`resolveTier5` and `resolveTier5Batch`) for instant candidate QA bank vector indexing.
  - `synthesizeBatchAnswers` includes candidate profile context block.
  - `finalizeLlmAnswer` includes 3-step fuzzy option fallback (normalized comparison, contains check for short options, Fuse.js threshold 0.85) before hard reject on choice fields.

## Immediate Blockers / Open Questions
- None as of 2026-09-16 (migrations 016/017, Storage ingest keys, and prod smoke assumed done).
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
