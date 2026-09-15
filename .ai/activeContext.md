# Active Context — Current Sprint State

_Last updated: 2026-09-15 (session end — main `b8b0276`; uncommitted Zoho Step logs + dashboard field filter)_

## Current Focus (Active Sprint)

### 1. Manager / COO Analytics Dashboard
- Separate from the operator dashboard
- Needs visibility into: application throughput, success rates, candidate statuses, failure breakdown
- Status: **early build** — API + static UI shipped: `GET /api/manager/dashboard`, operator link to **`/manager`**
- Admin gate: `isUserAdmin()` in `auth.ts`; org-wide stats (no `careerassociatemanager_id` scoping)

### 2. Resolution Engine — Semantic Search for Resume Parsing
- Current Tier 2 (pdf-parse) + Tier 3 (Fuse.js fuzzy) sometimes miss relevant resume content
- **Shipped (2026-09-15, `31b830e`):** Tier 5 fail-closed — LLM answers that are not an exact option (or below min confidence) stay `unresolved`. SMS/recruiting/marketing opt-in questions are always filled **No** at submit time (`isConsentSmsMarketingField`)
- Open question: use vector embeddings vs. smarter Fuse.js tuning vs. structured extraction pre-pass
- Status: **semantic search still investigating**; fail-closed + SMS skip on `main`

### 3. Email Proof / OTP Reliability
- **OTP path fixed (2026-09-15):** `isGreenhouseOtpEmail` gate before extraction; verified live AWL-31428 → `NgW4NT62`
- **Confirmation path fixed:** forward-only window from `submitted_at`; OTP subjects rejected; `EMAIL_PROOF_PENDING`-only poller
- **`EMAIL_UNVERIFIED` (on `main`, `cf50a45`):** after 10m with no confirmation mail → `EMAIL_UNVERIFIED`. Migration 013 — operator reported applied
- **Session reset (`601d37d`):** each `fetchLatestOtp` goto-root + clear filter; empty user list → one `page.reload()` retry
- **Uncommitted:** numbered `[Zoho] Step 1`–`8` verification logs + extra 5s wait after user-list selector
- Remaining: not yet exercised against a live Greenhouse OTP challenge
- Status: **reset/retry on `main`; step logs local; live OTP verification still pending**

### 4. Submission Queue Integrity
- Duplicate live submissions guarded on `main` (`cf50a45`): `IN_FLIGHT_STATUSES` includes `EMAIL_PROOF_PENDING`; PATCH ignores naked `QUEUED` while in-flight; `persist: false` on poll and submit-response paths
- Status: **shipped; live verification pending**

### 5. CSV Ingestion Trigger
- Operator-driven: dashboard **▶ Start** → `POST /api/admin/trigger-ingest-from-storage` (202 + poll `ingest-status`). No Storage webhook
- Credential resolution (`src/db/client.ts`): prefer `service_role` JWT, else `SUPABASE_SERVICE_ROLE_KEY` (including `sb_secret_`); normalize quoted/Bearer/whitespace secrets
- Ingest (`0d02593`) probes **every** configured key with a fresh client and logs `jwt.role` + entry names. Empty list is a failed run
- Local `.env` with a `service_role` JWT lists `test(Sheet1).csv` at bucket root. Railway ▶ Start after `0d02593` still reported `entries=0` / `(none)` — **the process keys cannot see Storage objects** (anon/publishable behaviour)
- Admin probe: `GET /api/admin/supabase-storage-health` returns `keyProbes[]`
- Status: **code on `main`; Railway still cannot list the dropzone — put the legacy `eyJ…` service_role JWT in `SUPABASE_SERVICE_ROLE_KEY`**

### 6. Question cap + SKIPPED + empty forms
- **`MAX_JOB_QUESTIONS` default raised 23 → 35** (`716b42d`). Jobs with `field_count >= 35` upsert `SKIPPED` (`skippedApplications.ts`, migration **014**)
- Operator queue hides `SKIPPED` (`excludeSkippedApplicationJobs`)
- Empty `resolved_fields` hydrated from `scanned_job_templates.fields_schema` (`applicationFieldHydration.ts`, `2bca544`) so the dashboard is not a blank form after segregator-only upserts
- Status: **on `main`; apply migration 014 on Supabase if SKIPPED upserts fail the CHECK constraint**

### 7. Uncommitted (this session, not on `main`)
- `[Zoho] Step 1`–`8` verification logs + 5s user-list wait (`src/services/zohoReader.ts`)
- Dashboard carousel: show identity + `unresolved`/`ai`/`manual`/`resume` only (`dashboard/public/index.html`); submit payload still uses full `fields`
- Dropped `GET /api/candidates` totalJobs debug `console.log` (`src/server/index.ts`)

## Immediate Blockers / Open Questions
- [ ] Manager dashboard: additional metrics/views beyond date/client rollup? (needs product decision)
- [ ] Semantic search: choose approach (embeddings vs fuzzy tuning) before implementation
- [ ] **`ZOHO_CONNECTOR_USER` holds a password-shaped value, not an email** — operator must confirm the username
- [ ] **Migration 011** — `zoho_connected_profiles` still missing on the instance that logged the missing-table error (re-check)
- [ ] OTP fix not yet exercised against a *fresh* Greenhouse OTP challenge
- [ ] **Migration 014** (`SKIPPED`) — run in Supabase SQL Editor if not applied
- [ ] **Railway ingest still lists zero objects** after `0d02593` — both process keys behave like anon for Storage. Need legacy `service_role` JWT in `SUPABASE_SERVICE_ROLE_KEY`. After Start, read `Probe SUPABASE_… jwt.role=` lines
- [ ] ▶ Start not yet completed end-to-end (would archive `test(Sheet1).csv`)
- [ ] Duplicate-submission fix not yet exercised on a live submit
- [ ] Email proof `EMAIL_UNVERIFIED` path not live-verified

## Recent Decisions Made
- CSV ingestion is **operator-triggered, not event-driven**
- Long-running admin actions return `202` and expose a status endpoint
- CAPTCHA automation is explicitly out of scope
- Question cap is **35**, not 23 — further lifts need an explicit instruction (`AGENTS.md` rule 7)
- Over-cap jobs are persisted as `SKIPPED`, not silently omitted
- Tier 5 must **fail closed** on option mismatch — never write a guessed dropdown value
- SMS/recruiting opt-in is always **No** at fill time
- Empty storage lists with no error mean **wrong JWT role**, not an empty bucket
- Prefer probing every env key over trusting `listBuckets()` or a singleton client
- Queue ownership: in-flight statuses are never requeued; `persist: false` for poll/submit bookkeeping
- Operator UI source of truth is **`dashboard/public/index.html`**
- A reused Playwright page must be **reset to root and the filter cleared** before the next OTP lookup; one reload if the user list is empty

## How to Update This File
After each significant sprint or feature ship, update:
1. Move completed items to `progress.md` under "What Works"
2. Add new items to "Current Focus"
3. Update "Immediate Blockers" with fresh blockers/decisions needed
