# Active Context — Current Sprint State

_Last updated: 2026-10-07_

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
