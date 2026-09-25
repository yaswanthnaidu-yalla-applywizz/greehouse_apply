# Progress — What Works, What's Pending

_Last updated: 2026-09-21_

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

### OTP Retry and Submission-Gate Failure UI (2026-09-23)
- [x] Requeued OTP-fetch failures returned as `OTP_REQUIRED` through the submitter pool and accepted `OTP_REQUIRED` in the guarded retry transition.
- [x] Prevented double incrementing of `retry_count` by making the queue retry owner apply the increment once per attempt.
- [x] Added authoritative `submissionGateBlocked` metadata to application DTOs and job rows.
- [x] Limited the requirements panel to gate-blocked failures and exposed retry for ordinary failed applications.
- [x] Added `[OTP TRACE]` and `[Gate TRACE]` logs for production verification of the retry/session lifecycle and gate decisions.

## ✅ Fully Shipped (V2 — Production on Railway)

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
- [x] **Submission eligibility gate** — ingest all CSV scores; resolve all templates; gate at submit (score 20–60, field_count &lt; 35); Dev dashboard toggle; migration 019 (2026-09-16)
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
