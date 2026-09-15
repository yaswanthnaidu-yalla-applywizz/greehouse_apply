# Active Context — Current Sprint State

_Last updated: 2026-09-15 (ingest: prefer SERVICE_ROLE_KEY including sb_secret; list dropzone names)_

## Current Focus (Active Sprint)

### 1. Manager / COO Analytics Dashboard
- Separate from the operator dashboard
- Needs visibility into: application throughput, success rates, candidate statuses, failure breakdown
- Status: **early build** — API + static UI shipped: `GET /api/manager/dashboard`, operator link to **`/manager`**
- Admin gate: `isUserAdmin()` in `auth.ts`; org-wide stats (no `careerassociatemanager_id` scoping)

### 2. Resolution Engine — Semantic Search for Resume Parsing
- Current Tier 2 (pdf-parse) + Tier 3 (Fuse.js fuzzy) sometimes miss relevant resume content
- Goal: improve resume-to-question matching — investigating semantic search (embeddings) or better fuzzy strategies
- Open question: use vector embeddings vs. smarter Fuse.js tuning vs. structured extraction pre-pass
- Status: **investigating**

### 3. Email Proof / OTP Reliability
- Email proof capture via Zoho Mail Reader (`zohoReader.ts`) and `emailProofPoller.ts` needs reliability improvements
- **OTP path fixed (2026-09-15):** verbose step-by-step logging added to `zohoReader.ts` + `zoho-connector.ts`, which immediately exposed that `fetchLatestOtp` was returning wrong codes. Now gated on sender/subject/company before extraction; verified live against AWL-31428 → `NgW4NT62`
- **Confirmation path fixed (2026-09-15):** proof capture was storing the OTP mail — the ±5min window reached backwards past the submit. Now forward-only from `submitted_at`, with a `greenhouse-mail.io` sender gate, an explicit OTP-subject reject, and an `EMAIL_PROOF_PENDING`-only guard in `emailProofPoller.ts`
- **Subject patterns widened (uncommitted):** `CONFIRMATION_SUBJECT_PATTERN` also matches journey-started / application-submitted wording; company match can satisfy proof when subject names the company even if the pattern misses
- **`EMAIL_UNVERIFIED` (uncommitted):** after 10m with no confirmation mail, poller moves `EMAIL_PROOF_PENDING → EMAIL_UNVERIFIED` (web screenshot kept; `email_proof_status=manual_review_needed`). Dashboard shows amber badge, allows resubmit, keeps View Proof. Migration `013_add_email_unverified_status.sql`
- Remaining: not yet exercised against a live submission; migration 013 not applied on prod DB yet
- Status: **OTP + proof filters + timeout terminal state coded; live verification + migration apply pending**

### 4. Submission Queue Integrity
- **Duplicate live submissions fixed (2026-09-15):** one application ran on 2–3 workers concurrently and clicked submit 6 times (`b1f7250c`, AWL-31428 Prometheus). Guards: `IN_FLIGHT_STATUSES` now includes `EMAIL_PROOF_PENDING`; `PATCH /:id/status` skips requeue for any in-flight status on incoming `APPLYING` **or** `QUEUED` (direct PATCH `QUEUED` ignored — use `POST /:id/submit`); `SubmitterPool` tracks `inFlightApplicationIds`; badge poll and **submit-response** `onStatusChange` calls pass `persist: false`
- Reported as an OTP/CAPTCHA requeue bug, but **no requeue-on-failure path exists in the codebase** — the OTP/CAPTCHA failures in that log were the duplicate browsers racing on one form
- Status: **extended guards uncommitted on top of `37bab44`; live verification pending**

### 5. CSV Ingestion Trigger
- **Root-caused (2026-09-15):** uploading a CSV to the `csv_uploads` bucket triggered nothing because **no webhook and no poller exist** — `ingestCsvFromStorage` only had a one-shot CLI (`npm run ingest:storage`) and an admin HTTP route nothing called. Not a dead daemon: the queue worker is a separate concern and only runs in-process under `ENABLE_QUEUE_WORKER=true`
- Fixed by making ingestion explicitly operator-driven: `POST /api/admin/trigger-ingest-from-storage` is now admin-gated, returns `202` and runs in the background (409 while in flight), paired with `GET /api/admin/ingest-status`; the dashboard has an admin-only **▶ Start** button that polls it
- **Deployed run exposed a second defect (2026-09-15 12:34):** the Start button worked, but the run logged 4× `new row violates row-level security policy` and then "No pending CSV files" despite `test(Sheet1).csv` sitting in the bucket. Cause: the deployed `SUPABASE_SERVICE_KEY` is not a `service_role` key, so every storage read returns empty without an error. Ingestion now asserts bucket visibility and fails loudly, and no longer tries to provision buckets
- **JWT credential diagnostics:** `getSupabaseKeyDiagnostics()` logs `jwt.role`, `jwt.ref`, `urlRefMatch` on every ingest. `resolveSupabaseCredentials()` prefers a `service_role` JWT, else **whatever is in `SUPABASE_SERVICE_ROLE_KEY`** (including `sb_secret_` keys that have no JWT role — previously we skipped those and kept using anon in `SUPABASE_SERVICE_KEY`). Ingest no longer gates on `listBuckets`; it logs `storage.list root entries` and fails if that list is empty. Local probe (same project) sees `test(Sheet1).csv` at bucket root with a `service_role` JWT
- Status: **awaiting Railway deploy + ▶ Start** — look for `Found pending file … "test(Sheet1).csv"`

## Immediate Blockers / Open Questions
- [ ] Manager dashboard: additional metrics/views beyond date/client rollup? (needs product decision)
- [ ] Semantic search: choose approach (embeddings vs fuzzy tuning) before implementation
- [x] ~~Email proof: identify which edge cases are failing~~ — OTP extraction root-caused (see `progress.md`); confirmation path still open
- [ ] **`ZOHO_CONNECTOR_USER` holds a password-shaped value, not an email** (check `.env` directly; the literal is deliberately not repeated here) — needs an operator to confirm the correct username. Login yields 0 cookies and no POST, so a wrong value is currently undetectable
- [ ] **Migration 011 not applied** on the current Supabase instance — `zoho_connected_profiles` table is missing (`Could not find the table 'public.zoho_connected_profiles'`)
- [ ] OTP fix not yet exercised against a *fresh* Greenhouse OTP challenge — validated against existing security-code mail only (a live challenge needs an operator submission)
- [ ] **Uncommitted session batch (not on `main` yet):** `supabaseKeyDiagnostics.ts`, migration 013 / `EMAIL_UNVERIFIED`, Zoho confirmation patterns, requeue + persist fixes, dashboard badges — commit and push before prod deploy
- [ ] **Migration 013** (`EMAIL_UNVERIFIED`) not applied on Supabase — run `npm run db:migrate` after deploy
- [ ] **Railway ingest using anon while ROLE_KEY is set** — code now prefers `SUPABASE_SERVICE_ROLE_KEY` even without a JWT role claim; verify after deploy via `Credential identity` + `storage.list root entries`
- [ ] ▶ Start button not yet run end-to-end against a real CSV — the admin gate (403), status endpoint and UI were verified, but firing the pipeline processes and archives `test(Sheet1).csv` in Storage, so it needs operator go-ahead
- [ ] Duplicate-submission fix not yet exercised against a live submission — confirm `[API] Status → QUEUED (PATCH ...)` never appears during an `APPLYING` window, and that one app never occupies two workers
- [x] ~~**`src/types/index.ts` `ApplicationStatus` drift**~~ — aligned with DB in uncommitted diff (`APPROVED`, `QUEUED`, `CAPTCHA_REQUIRED`, `EMAIL_UNVERIFIED`). `src/db/applications.ts` remains canonical for server code

## Recent Decisions Made
- CSV ingestion is **operator-triggered, not event-driven** — no Supabase Storage webhook, no poller. A Storage webhook could not authenticate to `/api/admin/*` anyway (it is behind `requireAuth` + `isUserAdmin`)
- Long-running admin actions return `202` and expose a status endpoint; never awaited inside the request (the pipeline outlives any proxy timeout)
- CAPTCHA automation is explicitly out of scope — stay manual
- Context is now managed via `.ai/` folder (this refactor)
- V2 is considered shipped; active work is V2.5+ (dashboard improvements, resolution improvements)
- Manager dashboard admin access: single source of truth is `isUserAdmin()` (not per-route email allowlists); `/api/manager/*` currently admin-only
- Greenhouse custom selects: treat remix-css combobox inputs as first-class in `formFiller.ts` (not native `<select>`); sponsorship Y/N verified on live Prometheus board (`#question_32545342003`)
- Pinned demo candidates (`AWL-31428`, `AWL-YASWANTH`): job list API must union Supabase + bundled fixtures for admins
- Operator job queue UX: selecting a candidate does **not** auto-load the first job — operator must expand a job card to fetch application + form
- Production build: combobox option fallback roots must be `Locator` (`page.locator('body')`), not raw `Page` (Railway `tsc`)
- Zoho OTP: **scope the message population before extracting**, never tighten the regex alone — a permissive fallback converts "no result" into "wrong result", which the caller cannot detect. `extractOtpCode` is only safe on mail that passed `isGreenhouseOtpEmail()`
- Email proof: capture windows must be **forward-only from the submit timestamp** — any backward tolerance lets the pre-submit OTP mail qualify as proof
- Zoho connector auth: inbox access is **server-side OAuth per mailbox** (an unlinked mailbox returns `{"error":"Mailbox not connected"}`), so there is no client session to persist — 0 cookies is expected, and the Playwright "login" is effectively cosmetic on this deployment
- Queue ownership: `QUEUED`, `APPLYING`, `OTP_REQUIRED` and `CAPTCHA_REQUIRED` all mean **a worker owns the application** — nothing may requeue it, and only an operator submit moves an application to `QUEUED`
- **The client never writes back state it only read.** The dashboard polls status every 2s; a poll updates the display only. Persisting is reserved for operator-originated transitions, which is why `handleStatusChange` takes an explicit `persist` flag rather than inferring intent from the status value
- Operator UI source of truth is **`dashboard/public/index.html`** (inline Babel/JSX). The `dashboard/*.tsx` tree is an unserved parallel copy — nothing bundles it — so UI changes must land in the HTML; the `.tsx` edits only keep the copy from diverging
- `dashboard/tsconfig.json` + `npm run typecheck:dashboard` are chained into `npm run typecheck`, so the `.tsx` tree cannot silently re-accumulate errors. `npm run build` and the Dockerfile still compile `src/` only

## How to Update This File
After each significant sprint or feature ship, update:
1. Move completed items to `progress.md` under "What Works"
2. Add new items to "Current Focus"
3. Update "Immediate Blockers" with fresh blockers/decisions needed
