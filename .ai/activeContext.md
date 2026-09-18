# Active Context — Current Sprint State

_Last updated: 2026-09-17_

## Docs

- **`OVERVIEW.md`** (repo root, 2026-09-17) — four-perspective analysis (architect / developer / product / critique) with Mermaid diagrams. Not a sprint tracker; use this file for current focus.

## Current Focus

### 0e. Planned — Dashboard UI: bundled TSX (not started; info only)
- **Today (production):** Express serves `dashboard/public/*.html` + lazy `operator-app.jsx`; Babel Standalone on CDN compiles JSX in the browser. Styles: `dashboard/public/dashboard.css` (`npm run build:dashboard-css`). **`dashboard/App.tsx` and `components/*.tsx` are not served** — `dashboard/tsconfig.json` is `noEmit`; root `tsc` only builds `src/` → `dist/`.
- **Why two trees:** Historical inline-HTML approach vs typed mirror for `npm run typecheck:dashboard`. Operator fixes ship in **`index.html` / `operator-app.jsx`** until migration; `.tsx` can drift (see `.ai/progress.md` gotcha).
- **Target (recommended):** Vite (or similar) **multi-entry** build → static JS in `dashboard/public/`; thin HTML shells per route; drop in-browser Babel.
- **Migration order:** (1) operator — `App.tsx` entry, parity with `operator-app.jsx`; (2) manager — `ManagerDashboard.tsx` + `main-manager.tsx`; (3) **port** admin/dev from `admin.html` / `dev.html` (no `.tsx` exists yet); (4) delete duplicate Babel blocks + `operator-app.jsx`.
- **Routes unchanged:** `GET /`, `/manager`, `/admin`, `/dev` stay role-guarded HTML; only assets become pre-built bundles. Shared `DevSwitcher` / auth → TS modules, not four copy-paste HTML files.
- **Not a flip-switch:** needs CI/Railway `build:dashboard` step; cannot “use App.tsx only” without bundler + admin/dev port + QA on all four roles.

### 0a. Planned — Admin System ingest status bar (not started)
- **Problem:** `/admin` **System** tab only shows one line (`Ingest: running | idle | failed`); header **▶ Start** polls `GET /api/admin/ingest-status` but progress is easy to miss during long Playwright runs.
- **Plan:** Dedicated **ingest status bar** on **System** (and optionally sticky near header when `ingestRun.running`):
  - States: idle · running · success · failed · stopped (`running`, `startedAt`, `finishedAt`, `processedFile`, `message`, `error` from existing API).
  - While running: elapsed time, last poll timestamp, optional phase hint if we later expose it from server (for now: file name + startedAt only).
  - Reuse existing poll loop in `admin.html` (already polls every few seconds when `ingestRun.running`).
  - Match admin neo-brutalist card style; no new backend required unless we add phase field to `IngestRunState` later.
- **Out of scope for v1 bar:** per-URL scan percent (Railway logs only until optional progress API).

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

### 5. Resolution engine (future scope)
- Production 5-tier waterfall is shipped; no active sprint work.
- Possible later work: lower Tier 2/3 miss rate (resume parse, Fuse fuzzy, or semantic retrieval) — approach undecided, not scheduled.

## Immediate Blockers / Open Questions
- None as of 2026-09-16 (migrations 016/017, Storage ingest keys, and prod smoke assumed done).
- Operator-triggered retry is implemented locally; verify the retry button and atomic `FAILED` → `QUEUED` transition in operator smoke testing.

## Recent Decisions Made
- Manager team scope uses **`users.manager_email` → operator emails → `assigned_ca_email` / work-history union**, not ApplyWizz `careerassociatemanager_id` API alone.
- Operator queue shows **all** application rows (including SKIPPED); blocked statuses use operator-friendly **`error_message`** in the form panel.
- Default dashboard date window: **Today & Yesterday** (IST) unless `?from=&to=` override.
- **`candidate_applications` upsert timing:** no pre-resolve rows from segregator / `ensureApplicationRowsFromCsv`; resolver upserts only when at least one resolved field has a non-empty value (SKIPPED over-cap excepted).
- **AI ops:** Railway + Supabase investigations/deploy checks use **MCP**, not CLI (documented in `AGENTS.md` + `.ai/techContext.md`).
- **Prod crash fix (2026-09-16):** `X-Dashboard-Date-Range` must be visible ASCII — custom range labels use `-` not en-dash; `sanitizeHttpHeaderValue()` on `GET /api/candidates`.
