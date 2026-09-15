# Progress — What Works, What's Pending

_Last updated: 2026-09-15_

## ✅ Fully Shipped (V2 — Production on Railway)

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
- [x] Tier 3 — Fuse.js fuzzy match on qa_bank (`tier3FuzzyMatch.ts`)
- [x] Tier 4 — ApplyWizz API refetch + upsert (embedded in segregator / tier1 flow)
- [x] Tier 5 — Multi-provider LLM synthesis with qa_bank write-back (`tier5LLM.ts`, `llmSynthesizer.ts`)
- [x] Question fingerprinting via SHA-256 (`fingerprint.ts`)
- [x] Answer source tagging: `supabase`, `ai`, `manual`, `unresolved`

### Database
- [x] Full Supabase schema: 5 core tables + storage buckets
- [x] 13 incremental migrations applied (001–012 + latest combined)
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
- [x] Manager `GET /api/manager/dashboard` — admins see org-wide rollups (no CA API scoping)
- [x] Manager operator UI at **`/manager`** (Bearer token from operator login; not raw `/api/manager/dashboard`)
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
- [x] **Admin ▶ Start button for CSV ingestion** — `POST /api/admin/trigger-ingest-from-storage` is now admin-gated (`403` for non-admins, `409` while a run is in flight) and returns `202` with the pipeline running in the background; new `GET /api/admin/ingest-status` reports `{running, processedFile, message, error}`. Dashboard header has an `isAdminSession()`-gated **▶ Start** button that polls status every 5s, shows a banner for running/finished/failed, and refreshes candidate data when the run ends
- [x] **Zoho OTP reader hardened** — verbose step-by-step logging across `zohoReader.ts` (navigation/login status, session cookies, search query, raw message list, per-email sender/subject/timestamp, active regex) and `zoho-connector.ts` (request URL, HTTP status, raw body before parsing, parsed message summary). New `isGreenhouseOtpEmail()` sender+subject+company gate runs before extraction; scan 3 → 15 rows; 10-min window; `parseZohoEmailTimestamp` unified with the confirmation path; `reason` field on failure. Verified live against AWL-31428 → `NgW4NT62`

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
| Manager / COO analytics dashboard | Early build | `GET /dashboard` date-scoped client rollup; admins unfiltered across CAs |
| Resolution engine — semantic/fuzzy improvement | Investigating | Tier 2+3 miss rate; approach not yet decided |
| Email proof reliability | Awaiting live verification | OTP path and confirmation path both fixed 2026-09-15 (sender/subject gates, extractor patterns, forward-only capture window); neither exercised against a live submission yet |

---

## ⏳ Pending / V3 Scope

| Item | Notes |
|---|---|
| CAPTCHA automated bypass | CapSolver/2Captcha; explicitly out of scope for now |
| Multi-tenant RBAC / Row-Level Security | Supabase RLS; all access via service key currently |
| Supabase Storage bucket access policies | Deferred with RLS |
| Residential proxy pool | Anti-bot detection hardening |
| Lift `< 23` question restriction | One config change (`MAX_JOB_QUESTIONS=999`); pending validation |

---

## Known Bugs / Gotchas
- **✅ FIXED — CSV uploads to Storage never started the pipeline:** there was no webhook, no Realtime listener, no DB trigger and no poller; `ingestCsvFromStorage` was reachable only via the one-shot `npm run ingest:storage` CLI and an admin route the dashboard never called. Now operator-driven via the **▶ Start** button. A Storage webhook was rejected as an option because `/api/admin/*` sits behind `requireAuth` and Supabase cannot mint an operator token
- **✅ FIXED — Storage permission blindness reported as "no pending CSV files":** a non-`service_role` key gets an **empty list and no error** from both `listBuckets()` and `from(bucket).list()`, so ingestion reported `success: true, processedCount: 0` while the dropzone actually held a CSV, and `ensureBucketsExist()` (called on every ingest) concluded all four buckets were missing and logged 4× `new row violates row-level security policy` trying to recreate them. Ingestion now lists buckets to assert `csv_uploads` is visible and returns `success: false` naming the likely cause; bucket provisioning was dropped from the ingest path (it belongs to `npm run db:migrate`). Seen on deploy 2026-09-15 12:34 — the deployed `SUPABASE_SERVICE_KEY` was not the service_role secret
- **Gotcha — `SUPABASE_SERVICE_KEY` must be the `service_role` secret:** an anon/publishable key passes `isSupabaseConfigured()` and every storage read silently returns empty instead of failing. Decode the JWT and check `role` before blaming the code. Correct project ref: `dpwhgwdsfqzfwxlwvchp`
- **Gotcha — ingest run state is in-process memory:** `ingest-status` is a closure variable in `createServer`, so a Railway restart mid-run reports `{running: false}` with no history — and the pipeline itself dies with the process. Only one run can be in flight per server instance
- **✅ FIXED — Duplicate live submissions (same app on 2–3 workers):** `PATCH /api/applications/:id/status` rewrote `APPLYING → QUEUED` unconditionally, and the dashboard's `handleStatusChange` echoed back the status its 2s badge poll just read — so an application a worker was mid-fill on got thrown back in the queue and immediately re-dequeued into another lane. Observed 6 submit clicks for one app (`b1f7250c`, AWL-31428 Prometheus). Three fixes: the route skips the requeue when the current status is in `IN_FLIGHT_STATUSES` (`QUEUED`/`APPLYING`/`OTP_REQUIRED`/`CAPTCHA_REQUIRED`); `SubmitterPool` tracks `inFlightApplicationIds` so one id is never assigned to two lanes; and `handleStatusChange` takes a third `{ persist }` argument so poll-originated updates refresh the display without writing back (both pollers pass `persist: false`). **Not** an OTP/CAPTCHA requeue bug — no requeue-on-failure path exists anywhere in the codebase; the OTP/CAPTCHA failures in that log were the duplicate browsers racing on one form. See observation 0003
- **Gotcha — the dashboard `.tsx` tree is not the running UI:** `dashboard/public/index.html` (inline Babel/JSX) is what the server sends; `dashboard/App.tsx`, `FormRenderer.tsx`, `JobQueueView.tsx` and `components/*.tsx` are an unserved parallel copy. `tsconfig.json` is `"include": ["src/**/*"]` and `"build": "tsc"` has no bundler step, so those files are neither typechecked nor compiled. **Any operator-UI change must go in `index.html` to take effect**; edit the `.tsx` copies only to keep them from diverging further
- **✅ FIXED (2026-09-15) — 35 type errors in the dashboard `.tsx` tree**, from four root causes: (1) `CandidateDetail['jobs']` lacked the `applywizz_id`/`applywizzId` tags that `filterJobsForCandidate` reads, and because `JobWithOptionalOwner` is an all-optional *weak type*, TS rejected the call and fell back to the constraint — which cascaded into ~22 property errors in `JobQueueView.tsx`; (2) three divergent `ApplicationStatus` unions (`src/db/applications.ts` = 12 values and canonical per the DB CHECK constraint, `src/types/index.ts` = 9, `dashboard/types.ts` = 9) — `dashboard/types.ts` now re-exports the canonical one instead of redeclaring it; (3) `ResolvedField` never declared `isRequired`, though the scanner sets it and both UIs read it — added as optional to `src/types/index.ts`; (4) a genuine TDZ crash in `App.tsx` where the WebSocket `useEffect` listed `fetchCandidateDetail`/`fetchJobApplication` in its dependency array above their `useCallback` declarations (the array is evaluated during render, so it would throw on first mount) — the effect moved below them. **Note `src/types/index.ts` is still missing `APPROVED`, `QUEUED` and `CAPTCHA_REQUIRED`** relative to the DB constraint; left alone because nothing currently errors on it
- **Enforced since 2026-09-15:** `dashboard/tsconfig.json` (`noEmit`, same strictness as root) covers the whole tree, and `npm run typecheck` is now `tsc --noEmit && npm run typecheck:dashboard`, so the tree cannot silently re-accumulate errors. Verified with a positive control: a deliberately broken `.tsx` makes `npm run typecheck` exit 2. `npm run build` and the Dockerfile still run plain `tsc` on `src/` only, so the Railway deploy is unaffected
- **✅ FIXED — OTP email captured as email proof:** `queryZohoConfirmationEmail` used a ±5min window around submission, so the Greenhouse security-code mail that arrives *before* the submit landed inside the window and was stored as `proof_email_json`. The window is now forward-only (`submitted_at` → `+10min`, matching the poller budget), OTP/security-code subjects are explicitly rejected (logged), and a row must come from `greenhouse-mail.io` with a `thank you` / `application received` / `application confirmed` subject. The dead `sinceTimestamp` option on `captureAndSaveEmailProof` (3 call sites passed `submitted_at - 2min` into a parameter that was never read) is gone. `emailProofPoller.ts` additionally skips any cycle where status is not `EMAIL_PROOF_PENDING`, so nothing is captured mid-OTP flow
- **Gotcha — accept window is tied to the poller budget:** the connector accepts `submitted_at` → `+10min`, deliberately matching `emailProofPoller`'s 10min retry budget. If that budget changes, `WINDOW_MS` in `zoho-connector.ts` must change with it, or late confirmations silently end in `manual_review_needed`
- **✅ FIXED — Zoho OTP false positives:** `fetchLatestOtp` now gates on sender + subject + company via `isGreenhouseOtpEmail()` **before** any regex runs, scans 15 messages (was 3), and returns `reason: 'no matching greenhouse OTP email found'` rather than falling through to unrelated mail. Two bugs were behind this: Pattern 2 (`\b[A-Za-z0-9]{8}\b`) lifted `jobs2web` from a PG&E job-alert, and on the real Greenhouse email it returned the candidate name `Akshitha` instead of `NgW4NT62`. Added Pattern 0 for Greenhouse's "Copy and paste this code … : CODE" wording (the label and code are separated by a clause, which the old adjacency-based Pattern 1 could not match) and tightened Pattern 2 to require a digit **and** a letter. Verified live against AWL-31428 → `NgW4NT62`. See observation 0002
- **Gotcha — `extractOtpCode` is not safe standalone:** it is a pure extractor with a deliberately permissive last-resort pattern; an 8-char token like `jobs2web` is shape-indistinguishable from a real code. It must only ever be called on a message that has already passed `isGreenhouseOtpEmail()`
- **Zoho Reader login is effectively a no-op:** connector inbox access is server-side OAuth per mailbox, not session-based — login yields **0 cookies** and no POST request, yet mail reading works. The post-login success check resolves via the *fallback* filter-input selector, so a failed login is not detectable. `ZOHO_CONNECTOR_USER` in `.env` currently holds a password-shaped value rather than an email (check `.env` directly) and nothing rejects it
- **`fetchLatestOtp` timestamp parsing is weaker than the confirmation path:** it uses raw `Date.parse(whenText)` while `captureConfirmationEmailContent` uses `parseZohoEmailTimestamp` — relative formats ("Today, 11:25 AM") will not parse in the OTP path
- **`zoho_connected_profiles` missing:** migration 011 is not applied on the current Supabase instance (`Could not find the table 'public.zoho_connected_profiles'`)
- **Manager API in browser:** Opening `/api/manager/dashboard` without `Authorization: Bearer` always returns 401 — use **`/manager`** after operator sign-in
- **Demo job scores:** Akshitha fixture jobs use scores 90–95; dashboard score filter (20–60) is bypassed for pinned demo IDs only
- **E2E integration** (`npm test`): 28/32 checkpoints pass locally; Tier 1 “Email” resolution assertions fail while dry-run still fills email via `company_email` — investigate resolver profile/email mapping, not a dashboard blocker
- Local dev defaults LLM to **Ollama** (`llama3.1:latest`) — will fail silently if Ollama isn't running; override with `LLM_PROVIDER=openrouter`
- `RAILWAY_ENV=true` must be set on Railway or headful Playwright will try to open a display and fail
- `candidate_resume_parsed` is parsed once and cached; if resume changes, the old parse is stale — no auto-invalidation
- The `< 23` field count filter runs at scan time and is stored on `scanned_job_templates.field_count`; changing `MAX_JOB_QUESTIONS` requires re-scanning affected jobs
- **React-Select combobox:** Do not use keyboard Enter as a fallback after failed option click — it clears the type-ahead without committing (use option click or flyout toggle). Full-page option search uses `page.locator('body')` (Locator, not Page) for portaled menus.
- **Local dry-run script** (`runUserApplication.ts`) is separate from dashboard `POST .../dry-run` (`dryRun.ts` + Supabase application row)
