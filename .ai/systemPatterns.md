# System Patterns — Architecture, Schemas & Rules

## Pipeline Architecture (Dual-Branch)

```
Input CSV (greenhouse_only_applywizz_prod(in).csv)
         │
         ├─ BRANCH 1: Job Scanning (unique URLs only)
         │     csvDeduplicator → normalize URLs, resolve grnh.se shortlinks, deduplicate
         │     PlaywrightScanner (headless, 3–5 parallel workers, 3–6s jitter)
         │       → extracts: text, textarea, select, radio, checkbox, file, location_autocomplete
         │       → captures: label, required flag (including hidden `required_*` / `input.hidden[value="true"]` markers), dropdown options
         │       → detects: expired/404 jobs
         │     exportScannedJobs → upsert to `scanned_job_templates`
         │
         └─ BRANCH 2: Candidate Sync & Resolution
               segregateCandidatesByApplyWizzId → group CSV by AWL ID
               → ApplyWizz API sync (CSV IDs are the approval) → profile JSON + resume PDF → `profiles`
               → AnswerResolver (5-Tier Waterfall, per candidate × job field)
                     → upsert `candidate_applications` only after resolve (≥1 non-empty field), or SKIPPED if over cap; no segregator upsert
                     │
                     ▼
               Operator Dashboard (Express REST + React Native Web)
                 Left pane: candidate list (search, status badges)
                 Right pane: job tabs → pre-populated Q&A + source badges
                             [Dry-Run] [Approve & Submit] [View Proof]
                                 │
                                 ▼
                         Playwright Submission Engine
                           → fill form → CAPTCHA check → submit → confirm → screenshot
                           → proof → Supabase Storage → status = APPLIED
```

## 5-Tier Answer Resolution Waterfall
Short-circuits on first hit. Each tier feeds the next as fallback.

| Tier | Module | Mechanism | Cost |
|---|---|---|---|
| 1 | `tier1Supabase.ts` | Direct lookup in `profiles` + `candidate_qa_bank` by fingerprint | Free (DB only) |
| 2 | `tier2ResumeParse.ts` | `pdf-parse` on resume PDF → cached in `candidate_resume_parsed` (parse once) | Free after first parse |
| 3 | `semanticSearch.ts` | OpenRouter `text-embedding-3-small` vector similarity (≥ 0.88) via Supabase RPC against `candidate_qa_bank` | Embedding API cost |
| 4 | `tier3FuzzyMatch.ts` | Fuse.js (threshold ≥ 0.85) against `candidate_qa_bank` | Free (in-memory) |
| 5 | `tier5LLM.ts` via `llmSynthesizer.ts` | Multi-provider LLM prompt → answer and embedding written to `candidate_qa_bank` for reuse | LLM cost |

**Rule:** LLM answers and manual edits written to `candidate_qa_bank` with embeddings (`writeEmbedding`) → resolved at Tier 1/3 on next run.

**Tier 5 fail-closed (`llmSynthesizer.ts`):** if the model answer is not an **exact** dropdown/radio option, or confidence is below `LLM_MIN_CONFIDENCE`, the field stays `unresolved` — never a guessed option. Profile Yes/No that is not an exact option is also left unresolved.

**SMS / recruiting opt-in (`formFiller.ts` `isConsentSmsMarketingField`):** at fill time these questions are always answered **No** (not sent through the resolver).

## Question Fingerprinting
`SHA-256(label|type)` → 16-char hex prefix = `question_fingerprint`  
Used as the key in `candidate_qa_bank`. Defined in `src/resolver/fingerprint.ts`.

## Application Status Lifecycle
```
READY_FOR_REVIEW → APPROVED → QUEUED → APPLYING → APPLIED
                                        → EMAIL_PROOF_PENDING → APPLIED (email proof captured)
                                                             → EMAIL_PROOF_PENDING (10m timeout; manual email screenshot retry remains available)
                                        → FAILED
                                        → CAPTCHA_REQUIRED / CAPTCHA_TIMEOUT
                                        → OTP_REQUIRED (renamed from CAPTCHA in migration 002)
                → DRY_RUN_COMPLETE
                → EXPIRED
                → SKIPPED (field_count >= MAX_JOB_QUESTIONS; migration 014)
```
`EMAIL_PROOF_PENDING` remains the application status after the 10-minute automatic email-proof timeout. The timeout sets `email_proof_status=manual_review_needed` and keeps manual email screenshot capture available; it does not make the application resubmittable. `SKIPPED` (014) is written at resolve time for over-cap jobs.

## Answer Source Tags (Dashboard Badges)
| Tag | Color | Meaning |
|---|---|---|
| `supabase` | 🟢 Green | Resolved from Supabase profiles/qa_bank |
| `ai` | 🟣 Purple | LLM-synthesized |
| `manual` | 🟡 Amber | Operator-edited in dashboard |
| `unresolved` | 🔴 Red | No answer found across all 5 tiers |

## Submission Flow Rules
- **Dry-run:** Headful Playwright fill, no submit, screenshot → `DRY_RUN_COMPLETE`
- **Live submit:** Headless fill → detect CAPTCHA/OTP → pause if needed → submit → watch for confirmation signals → screenshot → `APPLIED`
- **Confirmation detection:** tab title = "Thank you for applying" OR DOM keywords ("thanks", "applying", "track your application") OR URL contains `/confirmation`
- **Cascade fields:** `cascadeDetector.ts` handles conditional/dependent form fields
- **Resume availability:** Live submission verifies the required resume exists in Supabase Storage before filling; if unavailable, it re-downloads from ApplyWizz, uploads it, updates `profiles.resume_storage_path`, and fails before form fill if recovery fails.
- **Resume upload:** Handled via file input in form filler (`formFiller.ts`)
- **Custom selects (Greenhouse remix-css / React-Select):** Many `select`-typed questions use `.field-wrapper` → `.select-shell` → `.select__input` with `input[role="combobox"]#question_*`, plus a hidden `requiredInput` for form validation — not a visible native `<select>`. Fill path: single click on combobox input (avoid open+close double-click on same input), type answer, match options inside `.field-wrapper` first then `body` for portaled menus, optional **Toggle flyout** button, exact then case-insensitive contains/fuzzy matching. EEOC race answers are normalized to common Greenhouse variants such as `Asian (not Hispanic or Latino)`. Success = `.select__single-value` shows the answer. Log: `Populated via searchable select input`. **Never** press Enter on failed combobox fill — Greenhouse clears the filter without selecting. Example: AWL-31428 Prometheus “require sponsorship to work in the U.S.?” → `#question_32545342003`, options `Yes` / `No`.
- **Pinned demo job queue:** `AWL-31428` / `AWL-YASWANTH` jobs come from bundled fixtures (`akshithaDemoFixtures.ts`) merged with Supabase rows on `GET /api/candidates/:id/jobs` for admins — partial DB rows alone must not hide fixture jobs. `excludeSkippedApplicationJobs` drops `SKIPPED` rows from the operator queue.
- **Empty `resolved_fields` hydration:** `hydrateApplicationResolvedFields` copies `scanned_job_templates.fields_schema` into unresolved field shells when a row exists but fields were never populated. Does not persist the shells unless a later write does. Rows without resolution may not exist in DB at all (post-2026-09-16 upsert policy).
- **OTP resolution (Zoho) — reset, then scope before extract:** Before every `fetchLatestOtp`, `resetUiBeforeLookup` navigates to `ZOHO_CONNECTOR_URL`, waits for `input[placeholder*="Filter by email"]`, waits 5s for the user list, and clears the filter (do not assume it is empty). Search exact email then prefix-before-`@`. If both return 0 rows: log `[Zoho Reader] ⚠️ Zero rows after reset — retrying with full reload.`, `page.reload()`, wait for the filter, search once more; still 0 → not-found. Then gate every inbox row through `isGreenhouseOtpEmail(from, subject, companyName?)` **before** any regex: sender contains `greenhouse-mail.io`, subject matches `/security\s*code/i`, and (when `companyName` is passed) the subject mentions the company. Scans the newest **20** rows inside a **15-minute window** from `sinceTimestamp`; on zero gate matches it returns `{ success: false, reason: 'no matching greenhouse OTP email found' }` and **never** falls through to unrelated mail. `extractOtpCode` is a pure extractor whose last-resort pattern is deliberately permissive — calling it on ungated mail yields confident wrong codes (observed: `jobs2web` from a job-alert email). Greenhouse's real wording is *"Copy and paste this code into the security code field on your application: `NgW4NT62`"* — the label and code are separated by a clause, so `Pattern 0` handles it; adjacency-based patterns miss, and the mixed-case fallback then returns the candidate's own name from the greeting. Timestamps in this path use `parseZohoEmailTimestamp` (same as the confirmation path), never raw `Date.parse`. Lookup steps log `[Zoho] Step 1`…`Step 8` (navigate, login, user list, search, click row, Read Mails, mail list, extract).
- **Email proof (confirmation) — scope before capture:** `queryZohoConfirmationEmail` in `zoho-connector.ts` accepts a row only if ALL hold: subject does **not** match `/security code|\botp\b|one[-\s]?time (pass)?code/i` (rejected rows log `Rejected email (OTP/security code): {subject}`), sender contains `greenhouse-mail.io`, subject matches `/thank you|application received|application confirmed|journey.*started|application.*submitted|received.*application/i` **or** (with company gate) subject contains the company name, `received_time >= submitted_at` (never before — the OTP mail precedes the submit), `received_time <= submitted_at + 10min` (`WINDOW_MS` mirrors `emailProofPoller`'s 10min retry budget — change both together), and the existing company match. On success: `Proof email captured: {subject} from {sender} at {timestamp}`. `emailProofPoller.ts` only queries while status is `EMAIL_PROOF_PENDING` — it skips the cycle during `OTP_REQUIRED` / `CAPTCHA_*` so OTP mail can never be captured as proof. After 10m with no match: status remains `EMAIL_PROOF_PENDING`, `email_proof_status=manual_review_needed`, web proof is retained, and the operator can use **Get email screenshot**.
- **An in-flight application is never requeued except for bounded transient retry:** `QUEUED`, `APPLYING`, `OTP_REQUIRED`, `CAPTCHA_REQUIRED` and `EMAIL_PROOF_PENDING` all mean a worker or proof poller owns the application. `PATCH /api/applications/:id/status` translates incoming `APPLYING` to `QUEUED` (submit path) **only** when current status is outside `IN_FLIGHT_STATUSES`; incoming `QUEUED` while in-flight is ignored (use `POST /:id/submit`). The dashboard badge polls every 2s and submit handlers call `onStatusChange` with `{ persist: false }` so polled or response-derived status is display-only. `SubmitterPool` holds `inFlightApplicationIds` as the second guard. OTP fetch failures may requeue automatically up to `retry_count = 3`; other failures are not automatically requeued.
- **Zoho connector waits:** the connector is a long-polling SPA — use fixed `waitForTimeout` (5s after user-list ready on session reset, 5s after selecting a user, 9s after "Read mails"), **never** `waitForLoadState('networkidle')`.

## Supabase DB Schema

### `profiles`
| Column | Type | Notes |
|---|---|---|
| `applywizz_id` | TEXT UNIQUE | Primary identifier (e.g. `AWL-31428`) |
| `client_name`, `first_name`, `last_name` | TEXT | |
| `email`, `phone`, `location` | TEXT | |
| `country`, `country_code` | TEXT | Residential country + phone calling code. Migration **016**. Missing columns make `upsertProfile` fail, so new IDs never get a `profiles` row |
| `linkedin_url` | TEXT | |
| `work_authorization` | TEXT | |
| `requires_sponsorship` | BOOLEAN | |
| `education` | JSONB | Array of education objects |
| `work_experience` | JSONB | Array of experience objects |
| `resume_storage_path` | TEXT | Supabase Storage path |
| `raw_api_payload` | JSONB | Full ApplyWizz API response |
| `last_api_fetch_at` | TIMESTAMPTZ | Tier 4 refetch timestamp |

### `candidate_resume_parsed`
| Column | Type | Notes |
|---|---|---|
| `applywizz_id` | TEXT UNIQUE FK | |
| `raw_text` | TEXT | Full extracted text |
| `structured` | JSONB | `{name, email, phone, skills[], experience[], education[], rawSections}` |
| `parse_failed` | BOOLEAN | |
| `parse_error` | TEXT | |

### `gh_candidate_qa_bank`
| Column | Type | Notes |
|---|---|---|
| `applywizz_id` | TEXT FK | |
| `question_fingerprint` | TEXT | 16-char SHA-256 hex |
| `question_label` | TEXT | Human-readable label |
| `field_type` | TEXT | Form field type |
| `value` | TEXT | Resolved answer |
| `source` | TEXT | `ai` \| `manual` |
| `confidence` | FLOAT | LLM confidence score |
| UNIQUE | | `(applywizz_id, question_fingerprint)` |

### `gh_scanned_job_templates`
| Column | Type | Notes |
|---|---|---|
| `job_url` | TEXT UNIQUE | Normalized Greenhouse URL |
| `company_name`, `job_title` | TEXT | |
| `fields_schema` | JSONB | Array of `ScannedField` |
| `field_count` | INTEGER | Computed; compared to `MAX_JOB_QUESTIONS` |
| `is_expired` | BOOLEAN | |

### `gh_candidate_applications`
| Column | Type | Notes |
|---|---|---|
| `applywizz_id` | TEXT FK | Must exist in `profiles` before upsert. Rows created at **resolve** (or SKIPPED over-cap), not at CSV segregator |
| `template_id` | TEXT FK | References `gh_scanned_job_templates` |
| `job_url` | TEXT | |
| `status` | ENUM | See lifecycle above |
| `resolved_fields` | JSONB | Snapshot of all resolved answers |
| `proof_web_url` | TEXT | Supabase Storage URL |
| `proof_captured_at` | TIMESTAMPTZ | |
| `dry_run_screenshot_url` | TEXT | |
| `submitted_at` | TIMESTAMPTZ | |
| `retry_count` | INTEGER | Automatic OTP-fetch / unresolved-required-field retries used; max 3 before `FAILED` |
| `error_message` | TEXT | |
| UNIQUE | | `(applywizz_id, job_url)` — idempotent upsert |

### `zoho_connected_profiles` (migration 011)
Tracks Zoho Mail accounts linked to candidates for email proof capture.

### Supabase Storage Buckets
| Bucket | Path Pattern | Contents |
|---|---|---|
| `resumes` | `resumes/resume_{first_name}_{last_name}_{domain_shortcode}.pdf` | Candidate resume PDFs; shortcode is DA, SDE, PM, BA, MKT, FIN, UX, OPS, or GEN |
| `proofs_web` | `proofs/{app_id}_web.png` | Confirmation screenshots |
| `proofs_dry_run` | `dry-run/{app_id}_dryrun.png` | Dry-run screenshots |

### `gh_audit_events` (migration 015)
Organization audit log written by the server (signup, login, logout, ingest start, assignment PATCH). Missing table is fail-closed (warn + continue). RLS on; `service_role` only — no anon/authenticated policies.

### `gh_application_events` (migration 015)
Status-change timeline written from `updateStatus()`. Used by manager Activity and the dev application debugger. Missing table is fail-closed. RLS on; `service_role` only.

### `gh_users` (migration 017)
Dashboard operator and manager profiles, mapping, and roles.

### DB Migrations (18 files, applied via `src/db/migrate.ts`)
`001` company_email | `002` captcha→otp_required rename | `003` proof_email_url | `004` optimization indexes | `005` round-robin queue | `006` email proof status | `007` proof_failed_url | `008` proof_email_json | `009` email_proof_pending | `010` Realtime on gh_candidate_applications | `011` zoho_connected_profiles | `012` approved status | `013` email_unverified status | `014` skipped status | `015` gh_audit_events + gh_application_events + service_role RLS | `016` profiles.country + country_code | `017` gh_users | `018` disable gh_users rls | `latest` combined

## Dashboard roles (email map — no DB)

`resolveRoleFromEmail()` in `src/server/routes/auth.ts` is the single source of truth. Case-insensitive. Missing email is never treated as admin.

| Role | Emails | Home | Can open |
|---|---|---|---|
| `dev` | `yaswanthnaiduyalla@applywizz.ai` | `/dev` | `/`, `/admin`, `/manager`, `/dev` (header switcher) |
| `admin` | `ramakrishna@applywizz.ai`, `anushabandreddy@applywizz.ai` | `/admin` | `/admin` only |
| `manager` | `balaji@applywizz.ai`, `ramakrishnaa.tejavath@applywizz.ai` | `/manager` | `/manager` only (all clients for now — `MANAGER_TEAM_SCOPE_ENABLED` is false until `careerassociatemanager_id` mapping is known) |
| `operator` | any other signed-up email | `/` | `/` only |

API guards: `/api/applications|candidates|notifications` → operator+dev; `/api/admin` → admin+dev; `/api/manager` → manager+dev; `/api/dev` → dev. Login returns `homePath`. CSV **▶ Start** lives on the Admin dashboard, not the operator header.

On login, role is set on the returned `user.role`, written to Supabase `app_metadata.role` (JWT claim on later tokens), and stamped on `req.user.role` in `requireAuth` from the email map (map wins over a stale claim).

## Key Architectural Rules
1. **Never re-parse a resume** — always check `candidate_resume_parsed` before calling pdf-parse
2. **Always fingerprint questions** — never store answers by raw label string
3. **LLM is last resort** — Tiers 1–4 must all miss before Tier 5 fires
4. **Idempotent upserts everywhere** — pipeline is safe to re-run; no duplicate rows
5. **Supabase service key for data access** — Express uses `service_role`. Core tables still have open `USING (true)` policies (multi-tenant RLS is V3). **015 event tables** enable RLS with **service_role-only** policies — do not add anon/authenticated `USING (true)` there. Storage `list()` with an anon/publishable JWT returns `[]` and no error — probe every configured key (`listSupabaseKeyCandidates`) before treating the dropzone as empty.
6. **RAILWAY_ENV=true** — disables headful mode, caps memory on Railway deployment
7. **Stdout in `src/` goes through `createLogger`** (`src/utils/logger.ts`) — `[ISO timestamp] [LEVEL] [MODULE] message`. Do not add new `console.log` / `warn` / `error` in `src/`.
8. **`haltWithDevAlert` is for systemic ingest failures only** — Playwright launch, Supabase unreachable / empty key probe, ApplyWizz 5xx/timeout, required-migration missing table, first LLM provider call down, malformed/empty CSV. Single job scan, single candidate resolve, CAPTCHA, OTP, and individual submit failures stay `[WARN]` and continue.
