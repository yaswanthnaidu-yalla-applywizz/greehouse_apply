# System Patterns — Architecture, Schemas & Rules

## Pipeline Architecture (Dual-Branch)

```
Input CSV (greenhouse_only_applywizz_prod(in).csv)
         │
         ├─ BRANCH 1: Job Scanning (unique URLs only)
         │     csvDeduplicator → normalize URLs, resolve grnh.se shortlinks, deduplicate
         │     PlaywrightScanner (headless, 3–5 parallel workers, 3–6s jitter)
         │       → extracts: text, textarea, select, radio, checkbox, file, location_autocomplete
         │       → captures: label, required flag, dropdown options
         │       → detects: expired/404 jobs
         │     exportScannedJobs → upsert to `scanned_job_templates`
         │
         └─ BRANCH 2: Candidate Sync & Resolution
               segregateCandidatesByApplyWizzId → group CSV by AWL ID
               → ApplyWizz API sync → profile JSON + resume PDF → Supabase Storage
               → AnswerResolver (5-Tier Waterfall, per candidate × job field)
               → candidate_applications upserted to Supabase
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
| 3 | `tier3FuzzyMatch.ts` | Fuse.js (threshold ≥ 0.85) against `candidate_qa_bank` fingerprints | Free (in-memory) |
| 4 | *(embedded in segregator)* | Full ApplyWizz API refetch → upsert to `profiles` | API call |
| 5 | `tier5LLM.ts` via `llmSynthesizer.ts` | Multi-provider LLM prompt → answer written to `candidate_qa_bank` for reuse | LLM cost |

**Rule:** LLM answers and manual edits written to `candidate_qa_bank` → resolved at Tier 1 on next run (zero LLM spend).

**Tier 5 fail-closed (`llmSynthesizer.ts`):** if the model answer is not an **exact** dropdown/radio option, or confidence is below `LLM_MIN_CONFIDENCE`, the field stays `unresolved` — never a guessed option. Profile Yes/No that is not an exact option is also left unresolved.

**SMS / recruiting opt-in (`formFiller.ts` `isConsentSmsMarketingField`):** at fill time these questions are always answered **No** (not sent through the resolver).

## Question Fingerprinting
`SHA-256(label|type)` → 16-char hex prefix = `question_fingerprint`  
Used as the key in `candidate_qa_bank`. Defined in `src/resolver/fingerprint.ts`.

## Application Status Lifecycle
```
READY_FOR_REVIEW → APPROVED → QUEUED → APPLYING → APPLIED
                                        → EMAIL_PROOF_PENDING → APPLIED (email proof captured)
                                                             → EMAIL_UNVERIFIED (10m timeout; web screenshot kept)
                                        → FAILED
                                        → CAPTCHA_REQUIRED / CAPTCHA_TIMEOUT
                                        → OTP_REQUIRED (renamed from CAPTCHA in migration 002)
                → DRY_RUN_COMPLETE
                → EXPIRED
                → SKIPPED (field_count >= MAX_JOB_QUESTIONS; migration 014)
```
`EMAIL_UNVERIFIED` added in migration **013** — operator may resubmit from dashboard; not a hard failure. `SKIPPED` (014) is written at resolve time for over-cap jobs.

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
- **Resume upload:** Handled via file input in form filler (`formFiller.ts`)
- **Custom selects (Greenhouse remix-css / React-Select):** Many `select`-typed questions use `.field-wrapper` → `.select-shell` → `.select__input` with `input[role="combobox"]#question_*`, plus a hidden `requiredInput` for form validation — not a visible native `<select>`. Fill path: single click on combobox input (avoid open+close double-click on same input), type answer, match options inside `.field-wrapper` first then `body` for portaled menus, optional **Toggle flyout** button, fuzzy match for sponsorship Y/N. Success = `.select__single-value` shows the answer. Log: `Populated via searchable select input`. **Never** press Enter on failed combobox fill — Greenhouse clears the filter without selecting. Example: AWL-31428 Prometheus “require sponsorship to work in the U.S.?” → `#question_32545342003`, options `Yes` / `No`.
- **Pinned demo job queue:** `AWL-31428` / `AWL-YASWANTH` jobs come from bundled fixtures (`akshithaDemoFixtures.ts`) merged with Supabase rows on `GET /api/candidates/:id/jobs` for admins — partial DB rows alone must not hide fixture jobs. `excludeSkippedApplicationJobs` drops `SKIPPED` rows from the operator queue.
- **Empty `resolved_fields` hydration:** `hydrateApplicationResolvedFields` copies `scanned_job_templates.fields_schema` into unresolved field shells when the application row exists but resolve never populated fields (segregator-only upsert). Does not persist the shells unless a later write does.
- **OTP resolution (Zoho) — scope before extract:** `fetchLatestOtp` in `zohoReader.ts` MUST gate every inbox row through `isGreenhouseOtpEmail(from, subject, companyName?)` **before** running any regex: sender contains `greenhouse-mail.io`, subject matches `/security\s*code/i`, and (when `companyName` is passed) the subject mentions the company. Scans the newest **15** rows inside a **10-minute window** from `sinceTimestamp`; on zero gate matches it returns `{ success: false, reason: 'no matching greenhouse OTP email found' }` and **never** falls through to unrelated mail. `extractOtpCode` is a pure extractor whose last-resort pattern is deliberately permissive — calling it on ungated mail yields confident wrong codes (observed: `jobs2web` from a job-alert email). Greenhouse's real wording is *"Copy and paste this code into the security code field on your application: `NgW4NT62`"* — the label and code are separated by a clause, so `Pattern 0` handles it; adjacency-based patterns miss, and the mixed-case fallback then returns the candidate's own name from the greeting. Timestamps in this path use `parseZohoEmailTimestamp` (same as the confirmation path), never raw `Date.parse`.
- **Email proof (confirmation) — scope before capture:** `queryZohoConfirmationEmail` in `zoho-connector.ts` accepts a row only if ALL hold: subject does **not** match `/security code|\botp\b|one[-\s]?time (pass)?code/i` (rejected rows log `Rejected email (OTP/security code): {subject}`), sender contains `greenhouse-mail.io`, subject matches `/thank you|application received|application confirmed|journey.*started|application.*submitted|received.*application/i` **or** (with company gate) subject contains the company name, `received_time >= submitted_at` (never before — the OTP mail precedes the submit), `received_time <= submitted_at + 10min` (`WINDOW_MS` mirrors `emailProofPoller`'s 10min retry budget — change both together), and the existing company match. On success: `Proof email captured: {subject} from {sender} at {timestamp}`. `emailProofPoller.ts` only queries while status is `EMAIL_PROOF_PENDING` — it skips the cycle during `OTP_REQUIRED` / `CAPTCHA_*` so OTP mail can never be captured as proof. After 10m with no match: status → `EMAIL_UNVERIFIED`, `email_proof_status=manual_review_needed`, web proof retained.
- **An in-flight application is never requeued:** `QUEUED`, `APPLYING`, `OTP_REQUIRED`, `CAPTCHA_REQUIRED` and `EMAIL_PROOF_PENDING` all mean a worker or proof poller owns the application. `PATCH /api/applications/:id/status` translates incoming `APPLYING` to `QUEUED` (submit path) **only** when current status is outside `IN_FLIGHT_STATUSES`; incoming `QUEUED` while in-flight is ignored (use `POST /:id/submit`). The dashboard badge polls every 2s and submit handlers call `onStatusChange` with `{ persist: false }` so polled or response-derived status is display-only. `SubmitterPool` holds `inFlightApplicationIds` as the second guard. There is **no automatic requeue on failure** — only operator submit enqueues.
- **Zoho connector waits:** the connector is a long-polling SPA — use fixed `waitForTimeout` (9s after "Read mails", 5s after selecting a user), **never** `waitForLoadState('networkidle')`.

## Supabase DB Schema

### `profiles`
| Column | Type | Notes |
|---|---|---|
| `applywizz_id` | TEXT UNIQUE | Primary identifier (e.g. `AWL-31428`) |
| `client_name`, `first_name`, `last_name` | TEXT | |
| `email`, `phone`, `location` | TEXT | |
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

### `candidate_qa_bank`
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

### `scanned_job_templates`
| Column | Type | Notes |
|---|---|---|
| `job_url` | TEXT UNIQUE | Normalized Greenhouse URL |
| `company_name`, `job_title` | TEXT | |
| `fields_schema` | JSONB | Array of `ScannedField` |
| `field_count` | INTEGER | Computed; compared to `MAX_JOB_QUESTIONS` |
| `is_expired` | BOOLEAN | |

### `candidate_applications`
| Column | Type | Notes |
|---|---|---|
| `applywizz_id` | TEXT FK | |
| `template_id` | TEXT FK | References `scanned_job_templates` |
| `job_url` | TEXT | |
| `status` | ENUM | See lifecycle above |
| `resolved_fields` | JSONB | Snapshot of all resolved answers |
| `proof_web_url` | TEXT | Supabase Storage URL |
| `proof_captured_at` | TIMESTAMPTZ | |
| `dry_run_screenshot_url` | TEXT | |
| `submitted_at` | TIMESTAMPTZ | |
| `error_message` | TEXT | |
| UNIQUE | | `(applywizz_id, job_url)` — idempotent upsert |

### `zoho_connected_profiles` (migration 011)
Tracks Zoho Mail accounts linked to candidates for email proof capture.

### Supabase Storage Buckets
| Bucket | Path Pattern | Contents |
|---|---|---|
| `resumes` | `resumes/{awl_id}_resume.pdf` | Candidate resume PDFs |
| `proofs_web` | `proofs/{app_id}_web.png` | Confirmation screenshots |
| `proofs_dry_run` | `dry-run/{app_id}_dryrun.png` | Dry-run screenshots |

### DB Migrations (15 files, applied via `src/db/migrate.ts`)
`001` company_email | `002` captcha→otp_required rename | `003` proof_email_url | `004` optimization indexes | `005` round-robin queue | `006` email proof status | `007` proof_failed_url | `008` proof_email_json | `009` email_proof_pending | `010` Realtime on candidate_applications | `011` zoho_connected_profiles | `012` approved status | `013` email_unverified status | `014` skipped status | `latest` combined

## Key Architectural Rules
1. **Never re-parse a resume** — always check `candidate_resume_parsed` before calling pdf-parse
2. **Always fingerprint questions** — never store answers by raw label string
3. **LLM is last resort** — Tiers 1–4 must all miss before Tier 5 fires
4. **Idempotent upserts everywhere** — pipeline is safe to re-run; no duplicate rows
5. **Supabase service key only** — no RLS enforced yet (V3 scope). Storage `list()` with an anon/publishable JWT returns `[]` and no error — probe every configured key (`listSupabaseKeyCandidates`) before treating the dropzone as empty.
6. **RAILWAY_ENV=true** — disables headful mode, caps memory on Railway deployment
