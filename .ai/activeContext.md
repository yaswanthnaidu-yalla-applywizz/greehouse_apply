# Active Context — Current Sprint State

_Last updated: 2026-09-15 (role-based dashboards + logger + AW logo committed to main; apply migration 015)_

## Current Focus (Active Sprint)

### 1. Role-based Admin / Manager / Dev dashboards
- Strict isolation: operator `/`, manager `/manager`, admin `/admin`, dev `/dev` + switcher
- Manager home keeps the existing client table with click-to-expand proofs and date/CA filters
- Admin has org overview + ▶ Start ingest; Dev has health / runs / debugger
- **Apply migration 015** (`audit_events`, `application_events`) in the Supabase SQL editor or Activity/audit tabs stay empty
- Status: **on `main`; apply migration 015**

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
- **Step logs on `main` (`8a44cf2`):** numbered `[Zoho] Step 1`–`8` + extra 5s wait after user-list selector
- Remaining: not yet exercised against a live Greenhouse OTP challenge
- Status: **reset/retry + step logs on `main`; live OTP verification still pending**

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

### 7. Central logger + AW logo (shipped with dashboards)
- **Central logger** — `src/utils/logger.ts` (`createLogger`); all `src/` `console.log`/`warn`/`error` swapped; format `[ISO] [LEVEL] [MODULE] message`
- App logo: square AW mark at `dashboard/public/logo.webp` (favicon + header/auth); `express.static(dashboard/public)` so `/logo.webp` is not swallowed by the HTML catch-all

## Immediate Blockers / Open Questions
- [ ] Manager dashboard: additional metrics/views beyond date/client rollup? (needs product decision)
- [ ] **Migration 015** (`audit_events` + `application_events`) — apply in Supabase SQL Editor or Activity / audit / debugger timelines stay empty
- [ ] Semantic search: choose approach (embeddings vs fuzzy tuning) before implementation
- [ ] **`ZOHO_CONNECTOR_USER` holds a password-shaped value, not an email** — operator must confirm the username
- [ ] **Migration 011** — `zoho_connected_profiles` still missing on the instance that logged the missing-table error (re-check)
- [ ] OTP fix not yet exercised against a *fresh* Greenhouse OTP challenge
- [ ] **Migration 014** (`SKIPPED`) — run in Supabase SQL Editor if not applied
- [ ] **Railway ingest still lists zero objects** after `0d02593` — both process keys behave like anon for Storage. Need legacy `service_role` JWT in `SUPABASE_SERVICE_ROLE_KEY`. After Start, read `Probe SUPABASE_… jwt.role=` lines
- [ ] ▶ Start not yet completed end-to-end (would archive `test(Sheet1).csv`)
- [ ] Duplicate-submission fix not yet exercised on a live submit
- [ ] Email proof `EMAIL_UNVERIFIED` path not live-verified
- [ ] **Skill-review apply** for open observations **0003, 0005, 0011** — listed 2026-09-15; user deferred to **end of week** (do not stage/action until then)

## Recent Decisions Made
- CSV ingestion is **admin-triggered from `/admin`**, not from the operator header
- Roles are isolated: managers cannot open operator/admin/dev; admins cannot open manager/operator/dev; missing email is never admin
- Manager dashboard currently shows **all clients** (`MANAGER_TEAM_SCOPE_ENABLED = false` in `clientDashboard.ts`). Re-enable team scoping once we know which `careerassociatemanager_id` maps to which manager email.
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
- All `src/` stdout goes through **`createLogger`** (`src/utils/logger.ts`) — no new raw `console.*` in `src/`
- Open skill observations **0003, 0005, 0011** stay open until an end-of-week apply (listing already done; do not restage this week unless asked)

## How to Update This File
After each significant sprint or feature ship, update:
1. Move completed items to `progress.md` under "What Works"
2. Add new items to "Current Focus"
3. Update "Immediate Blockers" with fresh blockers/decisions needed
