# System Patterns — Architecture, Schemas & Rules

## Pipeline Architecture (Dual-Branch & Multi-ATS)

```
Input CSV (greenhouse_only_applywizz_prod(in).csv)
         │
         ├─ ATS URL Detector (Greenhouse vs Ashby)
         │
         ├─ BRANCH 1: Job Scanning (unique URLs only)
         │     csvDeduplicator → normalize URLs, resolve grnh.se shortlinks, deduplicate
         │     Greenhouse: PlaywrightScanner (headless, 3–5 parallel workers, 3–6s jitter)
         │     Ashby: ashbyScanner (Playwright DOM only, [data-field-path])
         │       → extracts: text, textarea, select, radio, checkbox, file, location_autocomplete
         │       → captures: label, required flag (including hidden markers), dropdown options
         │       → detects: expired/404 jobs
         │     exportScannedJobs → upsert to `scanned_job_templates` (with `ats` column)
         │
         └─ BRANCH 2: Candidate Sync & Resolution
               segregateCandidatesByApplyWizzId → group CSV by AWL ID
               → ApplyWizz API sync (CSV IDs are the approval) → profile JSON + resume PDF → `profiles`
               → AnswerResolver (required questions only; optional questions remain blank):
                     - Ashby system field short-circuit (_systemfield_*) mapped directly from profile before Tier 1
                     - 5-Tier Waterfall for custom & ATS fields
               → Needs Review & Filtered-Out Routing:
                     - applicationShouldBeFilteredOut: unresolved required fields > 3 (required AI fields never filter out)
                     - applicationNeedsOperatorReview: unresolved required fields, required cover letter, or negative compensation
                     - Filtered-out applications tagged FILTERED_OUT and logged to Ingest Filter CSV report
               → upsert `candidate_applications` only after resolve (≥1 non-empty field); MAX_JOB_QUESTIONS retired (no skipping for field count)
               │
               ▼
         Post-Ingest Phase D Notifications & Poller
           - CA Notification Emails via Azure Graph
           - Leadership Ingestion Summary Email to Balaji & RK (CC: Anusha, Vivek, dev)
           - Background SLA Tracking Poller (1.5h initial check, 1h followups until 0 remaining or 2 stalled checks)
               │
               ▼
         Operator Dashboard (Express REST + Vite TSX React)
           Left pane: candidate list (search, status badges)
           Right pane: job tabs → pre-populated Q&A + source badges
                       [Dry-Run] [Approve & Submit] [View Proof]
                           │
                           ▼
         Submitter Pool & Queue Worker
           - Unified BrowserManager with playwright-extra + puppeteer-extra-plugin-stealth
           - Greenhouse: liveSubmit.ts (Remix/React-Select, OTP challenge via Zoho REST API)
           - Ashby: ashbySubmit.ts (Human-like Bézier cursor, micro-jitter typing, Turnstile settlement, DataImpulse geo-proxy)
           → submit → confirmation check → screenshot
           → proof → Supabase Storage → status = APPLIED / EMAIL_PROOF_PENDING
```

**Zoho eligibility during candidate ingestion:** The shared `segregateCandidatesByApplyWizzId` flow checks one live `/api/zoho/ui/users` snapshot after profile sync, matches connected emails to each synced profile's `company_email`, persists both true and false values to `profiles.zoho_connected`, and drops disconnected candidates before Phase D. If the connector request or response is invalid, it uses each profile's stored flag (`NULL` is disconnected); a live persistence error fails the ingestion phase. `SANDBOX=true` retains its Zoho-gate bypass.

## 5-Tier Answer Resolution Waterfall & Ashby Short-Circuit

### Ashby System Field Interception (Pre-Tier 1)
For Ashby jobs (`ats === 'ashby'`), Ashby system fields (e.g. `_systemfield_name`, `_systemfield_email`, `_systemfield_phoneNumber`, `_systemfield_resume`) are intercepted directly from the candidate profile before entering Tier 1:
- `_systemfield_name`: candidate full name
- `_systemfield_email`: company email (or candidate email)
- `_systemfield_phoneNumber`: candidate phone
- `_systemfield_resume`: resolved to sentinel `__FILE_UPLOAD__`
All other Ashby fields cascade into the standard 5-tier waterfall.

### Standard 5-Tier Waterfall
Short-circuits on first hit. Each tier feeds the next as fallback.

| Tier | Module | Mechanism | Cost |
|---|---|---|---|
| 1 | `tier1Supabase.ts` | Direct lookup in `profiles` + `candidate_qa_bank` by fingerprint | Free (DB only) |
| 2 | `tier2ResumeParse.ts` | `pdf-parse` on resume PDF → cached in `candidate_resume_parsed` (parse once) | Free after first parse |
| 3 | `semanticSearch.ts` | OpenRouter `text-embedding-3-small` similarity (≥ 0.82) against candidate profile/raw-payload fact labels, then Supabase vector search against `candidate_qa_bank` | Embedding API cost |
| 4 | `tier3FuzzyMatch.ts` | Fuse.js fuzzy match against candidate profile/raw-payload fact labels, then `candidate_qa_bank` | Free (in-memory) |
| 5 | `tier5LLM.ts` via `llmSynthesizer.ts` | Dual-pass LLM with DeepSeek R1 escalation waterfall (Claude 3.5 Haiku primary → DeepSeek R1 via OpenRouter fallback). AI proposals recorded to `gh_ai_answer_reviews` for two-level review. Answers promoted to QA bank on submission or manager approval. | LLM cost |

**Tier 5 Escalation Waterfall & Promotion Rules:**
- **Primary Model**: Claude 3.5 Haiku (`CLAUDE_MODEL`). Accepted if confidence ≥ 0.80 and exact choice matches.
- **DeepSeek R1 Escalation**: Triggers if Haiku is unresolved, confidence < 0.80, or choice does not exactly match scanned options. DeepSeek answer accepted only if confidence ≥ 0.65 and exact choice matches.
- **Fail-Closed Policy**: If DeepSeek fails, times out, or returns confidence < 0.65, the field remains `unresolved` (never adopts low-confidence Haiku).
- **Decoupled Persistence**: Tier 5 resolution NEVER directly writes to `candidate_qa_bank` or generates embeddings. Instead, accepted AI proposals are recorded immutably in `gh_ai_answer_reviews`. QA bank writes happen strictly via operator submission promotion or manager review approval.

Tier 3 profile-fact embeddings are generated on demand and cached in process memory; they do not require a database column or migration. Profile facts are searched before QA-bank entries in both Tiers 3 and 4.

**Tier 5 fail-closed (`llmSynthesizer.ts`):** if the model answer is not an **exact** dropdown/radio option, or confidence is below `LLM_MIN_CONFIDENCE`, the field stays `unresolved` — never a guessed option. Profile Yes/No that is not an exact option is also left unresolved.

**SMS / recruiting opt-in (`formFiller.ts` `isConsentSmsMarketingField`):** at fill time these questions are always answered **No** (not sent through the resolver).

**Choice-option alignment (`src/utils/choiceOptions.ts`):** complete select, radio, and checkbox answers are aligned against scanned option labels before persistence. Exact labels win; known semantic aliases cover yes/no polarity, U.S. country names, EEOC race/gender/veteran/disability values, and work-authorization prose. Ambiguous or unmatched values remain unresolved rather than falling back to the first option. Required searchable selects with `optionsComplete: false` retain their truthful `select` type and partial sample but are not constrained to it during resolution; only school/university/college questions use text entry in the operator UI, while other questions keep captured options visible. The live form remains authoritative. At submission time searchable Greenhouse/React controls must click a live option and verify the committed value; typed filter text alone is not success.
Resolver observability: `[Resolver Choice]` logs include the Tier 1 source, raw answer, scanned options, and canonical match (or `match=NONE`) so semantic alignment can be verified from ingest logs.

**Resolver evidence rules:** Country answers use `additional_information.zip_or_country` as the primary raw-payload fact; select/radio answers require a unique choice match, and a Tier 1 miss continues through Tiers 2–5 for standalone optional Country fields. Never synthesize country or calling-code values. Phone answers must come from the parsed resume contact facts, have an international calling prefix removed, and later-tier phone values must validate against that resume number; profile/API phone data is not a fallback. Tier 5 receives bounded question-conditioned resume/raw-payload evidence plus choices, and still must satisfy confidence and choice alignment.

**Availability date:** “Date available to start” is the UTC application date plus seven calendar days. Native/text answers use captured input/placeholder format metadata; dropdowns use a unique one-week option or the first listed option after “Immediately”, otherwise remain unresolved. Availability rules do not repurpose `desired_start_date` as a full value for month/year component fields. Education month/year fields use education-specific facts; missing component facts remain unresolved.

## Filtered-Out & Auto-Queue Application Routing (`src/resolver/needsReview.ts`)
Optional questions stay visible and blank in the operator form. They do not enter the resolver or the filtered-out counts.

- **Auto-Queue Eligibility**: Applications queue immediately (`READY_FOR_REVIEW` / `QUEUED`) when all required fields are satisfied, even if resolved by Tier 5 AI. Required AI answers no longer hold applications in operator review or trigger filtered-out status.
- **Filtered-Out Condition**: An application is routed to `FILTERED_OUT` ONLY when **unresolved required field count > 3** (`countUnresolvedRequiredFields(fields) > 3`).
- **Retired Field Cap**: `MAX_JOB_QUESTIONS` is retired. No application is skipped or filtered solely based on question or field count.
- **Preserved Execution Guards**: Applications are held for human review if:
  1. Any required field remains unresolved (`source === 'unresolved'`).
  2. Mandatory cover letter is required but empty.
  3. Negative compensation answer is detected.

## Post-Ingestion Leadership Notifications & SLA Tracking (`src/services/caNotificationEmail.ts`)
- Triggered automatically at Phase D completion via `sendLeadershipIngestionSummary`.
- Uses Azure Graph multi-recipient payload (`src/services/azureEmail.ts`) with `to` (Balaji & RK) and `cc` (Anusha, Vivek, dev).
- Renders HTML summary breakdown of total tasks ready for review grouped by CA and candidate.
- Spawns background SLA poller (`startLeadershipFollowupPoller`):
  - **1.5h Check**: If 0 tasks remain, sends completion email. If tasks remain, sends reminder email listing CAs with pending counts and starts hourly checks.
  - **Hourly Checks**: Exits with completion email when tasks hit 0, or terminates silently if remaining count stalls across two consecutive checks (`currentRemaining === lastRemaining`).
  - Guards: `timer.unref()` on all background timers; when `SANDBOX=true` or test mode, redirects strictly to dev email (`yaswanthnaiduyalla@applywizz.ai`) and empties CC.

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
                → SKIPPED (retired; MAX_JOB_QUESTIONS no longer enforced)
                → FILTERED_OUT (unresolved required > 3; migration 032; required AI answers do not filter)
```
`EMAIL_PROOF_PENDING` remains the application status after the 10-minute automatic email-proof timeout. The timeout sets `email_proof_status=manual_review_needed` and keeps manual email screenshot capture available; it does not make the application resubmittable. `SKIPPED` (014) is retired.

## Two-Level AI Answer Review Architecture (`gh_ai_answer_reviews`)

Decouples high-velocity application execution (auto-queueing & submissions) from authoritative answer curation (two-level human review & QA bank learning).

### 1. Proposal Identity & Tier 5 Lineage
- **Proposal Key**: `(application_id, resolution_revision, field_key)`
- AI proposals generated during Tier 5 resolution are captured immutably with full lineage: model name (`ai_model`), confidence score (`ai_confidence`), and prompt/escalation attempts (`ai_provenance`).
- Multiple resolution runs for the same application revision are idempotent and never overwrite original proposals; a new resolution revision creates separate proposal records.

### 2. Lifecycle Transitions & Review Stages
```
[Tier 5 Proposal] → status: pending_operator (revision: 1)
        │
        ├─ Operator Approve (AI value accepted) ───────┐
        ├─ Operator Edit (edited replacement provided) ─┼→ status: pending_manager (revision: 2)
        ├─ Operator Deny (denied without value) ────────┘
        │
        ▼
[Manager Review]
        ├─ Manager Approve ──→ status: approved (revision: 3) → upserts QA bank
        ├─ Manager Edit ──────→ status: approved (revision: 3) → upserts replacement in QA bank
        └─ Manager Reject ────→ status: rejected (revision: 3) → conditional QA row removal
```
- **Operator Denial Guard**: When an item has `operator_action === 'denied'`, the manager CANNOT directly approve the original proposal. The manager must either supply an `editedValue` (replacement) or choose `reject`. Direct approval attempts throw `400 Bad Request`.
- **Revision Tracking & Optimistic Locking**: Every mutation increments `revision`. Review endpoints verify `expectedRevision`, returning `409 Conflict` on stale submissions.
- **Idempotency Replay**: Client-generated `idempotencyKey` UUIDs are stored in `gh_ai_review_idempotency_keys` with cached response payloads, guaranteeing safe client retries without double-increments or duplicate mutations.

### 3. Operator Submission Promotion (Execution Learning Path)
- When an operator submits an application (`POST /api/applications/:id/submit` or live queue submit), all active AI answers in that application are promoted to `gh_candidate_qa_bank` with `source: 'manual'`, `confidence: 1.0`, and timestamp `promoted_at`.
- **Non-Blocking Error Isolation**: QA promotion errors are logged but strictly isolated. A failure in QA bank write never blocks or rolls back the application submission.
- **Promotion Reconciler (`reconcileAiAnswerPromotions`)**: Background recovery job detects submitted applications with unpromoted proposals, safely promotes them, and repairs pending embeddings.

### 4. Conditional Manager Rejection
- When a manager rejects an item (`action: 'reject'`), the system conditionally removes the answer from `gh_candidate_qa_bank` **ONLY IF** the current QA bank row value still matches `promoted_value`.
- If the QA row was subsequently updated (e.g. by a newer operator edit, manager edit, or manual profile correction), the newer QA row is preserved and remains untouched.
- If the proposal was never promoted or never in the QA bank, the QA bank is untouched.

### 5. Decoupled Embeddings
- Manager approvals and submission promotions set `embedding_status = 'pending'`.
- Vector embeddings (`text-embedding-3-small`, 1536 dims) are computed asynchronously by `syncReviewEmbedding`, checking the expected review revision so stale embedding jobs never overwrite newer QA bank states.

## Answer Source Tags (Dashboard Badges)
| Tag | Color | Meaning |
|---|---|---|
| `supabase` | 🟢 Green | Resolved from Supabase profiles/qa_bank |
| `ai` | 🟣 Purple | LLM-synthesized |
| `manual` | 🟡 Amber | Operator-edited in dashboard |
| `unresolved` | 🔴 Red | No answer found across all 5 tiers |

## Submission Flow Rules

The dequeue RPC allows another Ashby application for a candidate only after one hour from a successful submission (`submitted_at`). An Ashby success also blocks that candidate from the same company for 48 hours, using normalized company identity and the Ashby organization slug when available. Greenhouse jobs do not use these timed gaps. Failed attempts start neither timer. Migration 042 must be applied to DB 2 before these guards are active.

### Unified Stealth Browser (`src/submitter/browserManager.ts`)
Both Greenhouse and Ashby submissions use `BrowserManager` wrapped with `playwright-extra` and `puppeteer-extra-plugin-stealth`. Stealth evasion runs in both headless (Railway prod) and headful (local dry-run) environments.

### Greenhouse Submission (`src/submitter/liveSubmit.ts`)
- **Dry-run:** Headful Playwright fill, no submit, screenshot → `DRY_RUN_COMPLETE`
- **Live submit:** Headless fill → detect CAPTCHA/OTP → pause if needed → submit → watch for confirmation signals → screenshot → `APPLIED`
- CSV job score does not restrict queueing or live submission. The hard `MAX_JOB_QUESTIONS` cap remains enforced.
- **Confirmation detection:** tab title = "Thank you for applying" OR DOM keywords ("thanks", "applying", "track your application") OR URL contains `/confirmation`
- **Cascade fields:** `cascadeDetector.ts` handles conditional/dependent form fields
- **Resume availability:** Live submission verifies the required resume exists in Supabase Storage before filling; if unavailable, it re-downloads from ApplyWizz, uploads it, updates `profiles.resume_storage_path`, and fails before form fill if recovery fails.
- **Resume upload:** Handled via file input in form filler (`formFiller.ts` / `fileFiller.ts`)
- **Custom selects (Greenhouse remix-css / React-Select):** Many `select`-typed questions use `.field-wrapper` → `.select-shell` → `.select__input` with `input[role="combobox"]#question_*`, plus a hidden `requiredInput` for form validation — not a visible native `<select>`. Fill path: single click on combobox input (avoid open+close double-click on same input), type/filter answer, match live options inside `.field-wrapper` first then `body` for portaled menus, click the option, and verify the committed selected value (one retry is allowed). Option matching uses canonical semantic aliases as well as exact/contains/fuzzy matching. EEOC race answers are normalized to common Greenhouse variants such as `Asian (not Hispanic or Latino)`. Typed filter text while the menu is open is never accepted as success. Log: `Populated via searchable select input`. **Never** press Enter on failed combobox fill — Greenhouse clears the filter without selecting.
- **Pinned demo job queue:** `AWL-31428` / `AWL-YASWANTH` jobs come from bundled fixtures (`akshithaDemoFixtures.ts`) merged with Supabase rows on `GET /api/candidates/:id/jobs` for admins — partial DB rows alone must not hide fixture jobs. `excludeSkippedApplicationJobs` drops `SKIPPED` rows from the operator queue.
- **Empty `resolved_fields` hydration:** `hydrateApplicationResolvedFields` copies `scanned_job_templates.fields_schema` into unresolved field shells when a row exists but fields were never populated. Does not persist the shells unless a later write does. Rows without resolution may not exist in DB at all (post-2026-09-16 upsert policy).
- **OTP resolution (Zoho) — Fast REST API (`fetchZohoOtpViaApi` in `zoho-connector.ts`):** `otpResolutionService.ts` queries the Zoho connector REST API (`GET /api/zoho/ui/inbox` and `GET /api/zoho/ui/message`) directly without launching Playwright browsers. Inbound emails are gated by `isGreenhouseOtpEmail(from, subject, companyName?)` before extracting OTP: sender must contain `greenhouse-mail.io`, subject must match `/security\s*code/i`, and (when `companyName` is provided) subject or body must match the company. Scans messages within a 15-minute window from `sinceTimestamp`. `extractOtpCode` parses Greenhouse codes. The resolver uses a 10s poll interval within an 8-minute challenge budget.
- **Email proof (confirmation) — scope before capture:** `queryZohoConfirmationEmail` in `zoho-connector.ts` polls REST endpoints and accepts a row only if ALL hold: subject does **not** match `/security code|\botp\b|one[-\s]?time (pass)?code/i`, sender contains `greenhouse-mail.io`, subject matches `/thank you|application received|application confirmed|journey.*started|application.*submitted|received.*application/i` **or** contains company name, `received_time >= submitted_at`, and `received_time <= submitted_at + 10min`. After 10m with no match: status remains `EMAIL_PROOF_PENDING`, `email_proof_status=manual_review_needed`, web proof is retained, and the operator can use **Get email screenshot**.

### Ashby Submission (`src/submitter/ashbySubmit.ts`)
- **Geo-Targeted Residential Proxy (`src/submitter/ashbyProxy.ts`):** Strictly enforced DataImpulse proxy formatting:
  `<DATAIMPULSE_LOGIN>__cr.<country>;city.<city>;sid.<cleanId>_<YYYYMMDD>`.
  Halts immediately if credentials or proxy host are missing.
- **Human-Like Behavior (`src/submitter/ashbyFormFiller.ts`):**
  - Bézier curve mouse trajectory emulation for all interactions.
  - Micro-jitter typing delays (30–90ms per character).
  - Turnstile settlement scrolling to allow Cloudflare tokens to generate before button click.
  - Native file upload injection for resume.
- **Confirmation Detection:** Verifies green success banner with text:
  `"Your application was successfully submitted. We'll contact you if there are next steps."`
- **Rate-Limiting Guards (Migration 037 RPC):** Atomic selection in `get_next_queued_application()`:
  - 40–60 min jittered gap per candidate (`applywizz_id`).
  - 48-hour client-company cooldown.
  - 20-min global inter-company cooldown.
  - `scheduled_not_before` column ensures smooth paced dispatching.

### Submission Lifecycle State Rules
- **An in-flight application is never requeued except for bounded transient retry:** `QUEUED`, `APPLYING`, `OTP_REQUIRED`, `CAPTCHA_REQUIRED` and `EMAIL_PROOF_PENDING` all mean a worker or proof poller owns the application. `PATCH /api/applications/:id/status` translates incoming `APPLYING` to `QUEUED` (submit path) **only** when current status is outside `IN_FLIGHT_STATUSES`; incoming `QUEUED` while in-flight is ignored (use `POST /:id/submit`).
- OTP fetch failures return `OTP_REQUIRED` with `retryReason=OTP_FETCH_FAIL`; the pool requeues that result while the count is below 3.
- Structured failure diagnostics (`error_details` jsonb, migration 027) are captured on every live submission failure.

## Codebase Architecture & Modular Decomposition

The codebase was decomposed from earlier monolithic files into cohesive submodules:
1. **DB Applications (`src/db/applications/`)**:
   - `types.ts`: Application domain interfaces.
   - `memoryStore.ts`: In-memory caching layer.
   - `crud.ts`: Application row retrieval, creation, updates.
   - `dto.ts`: DB row to domain model mapping.
   - `statsQueries.ts`: Application counts and stats aggregations.
   - `queue.ts`: Queued application polling and lease management.
   - `notifications.ts`: Status notification triggers.
   - `index.ts`: Barrel export maintaining 100% backward compatibility.
2. **Strategy-Based Field Fillers (`src/submitter/fieldFillers/`)**:
   - `base.ts`: Abstract base field filler and DOM contract.
   - `textFiller.ts`: Text and textarea inputs.
   - `selectFiller.ts`: Native and custom combobox/searchable select dropdowns.
   - `booleanFiller.ts`: Checkboxes and radio button groups.
   - `fileFiller.ts`: Resume and attachment file uploads.
3. **Inbox Connector Modularization (`src/services/inbox/`)**:
   - `inboxPoller.ts`: Generic polling engine with timeout and retry budget.
   - `zohoStrategy.ts`: Zoho REST API adapter.
   - `gmailStrategy.ts`: Gmail REST/OAuth adapter.
4. **Centralized Choice Options (`src/utils/choiceOptions.ts`)**:
   - Canonical choice matching, token coverage, and negative decline logic.
5. **Isolated Demo Fixtures (`src/dashboard/demoFixtureService.ts`)**:
   - Cleanly separated from production DB logic.
6. **Decoupled Server Routes (`src/server/routes/`)**:
   - `candidates.ts`: Candidate profile fetching, resumes, and status updates.
   - `devDb.ts`: Dev DB explorer and debugging endpoints.
   - `applications.ts`: Application operations and submissions.

## Supabase DB Schema

### `profiles`
| Column | Type | Notes |
|---|---|---|
| `applywizz_id` | TEXT UNIQUE | Primary identifier (e.g. `AWL-31428`) |
| `client_name`, `first_name`, `last_name` | TEXT | |
| `email`, `phone`, `location` | TEXT | |
| `country`, `country_code` | TEXT | Residential country + phone calling code. Migration **016** |
| `linkedin_url` | TEXT | |
| `work_authorization` | TEXT | |
| `requires_sponsorship` | BOOLEAN | |
| `education` | JSONB | Array of education objects |
| `work_experience` | JSONB | Array of experience objects |
| `resume_storage_path` | TEXT | Supabase Storage path (Migration **033**) |
| `raw_api_payload` | JSONB | Full ApplyWizz API response |
| `last_api_fetch_at` | TIMESTAMPTZ | Tier 4 refetch timestamp |
| `zoho_connected` | BOOLEAN | Zoho email eligibility flag |

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
| `embedding` | VECTOR(1536) | pgvector embedding (Migration **021**) |
| UNIQUE | | `(applywizz_id, question_fingerprint)` |

### `gh_scanned_job_templates`
| Column | Type | Notes |
|---|---|---|
| `job_url` | TEXT UNIQUE | Normalized Greenhouse or Ashby URL |
| `company_name`, `job_title` | TEXT | |
| `ats` | TEXT | `greenhouse` \| `ashby` (Migration **036**) |
| `fields_schema` | JSONB | Array of `ScannedField` |
| `field_count` | INTEGER | Computed; compared to `MAX_JOB_QUESTIONS` |
| `is_expired` | BOOLEAN | |
| `job_posting_location` | TEXT | Captured posting location (Migration **046**) |
| `job_posting_facts` | JSONB | Structured posting location facts (Migration **046**) |

### `gh_candidate_applications`
| Column | Type | Notes |
|---|---|---|
| `task_id` | TEXT | External task UUID differentiating individual runs; UNIQUE when present (Migration **035**) |
| `legacy_application_key` | GENERATED TEXT | Unique key for rows without `task_id` |
| `applywizz_id` | TEXT FK | Must exist in `profiles` before upsert. Rows created at **resolve** (or SKIPPED over-cap) |
| `template_id` | TEXT FK | References `gh_scanned_job_templates` |
| `job_url` | TEXT | |
| `ats` | TEXT | `greenhouse` \| `ashby` (Migration **036**) |
| `status` | ENUM | See lifecycle above |
| `resolved_fields` | JSONB | Snapshot of all resolved answers |
| `proof_web_url` | TEXT | Supabase Storage URL |
| `proof_captured_at` | TIMESTAMPTZ | |
| `dry_run_screenshot_url` | TEXT | |
| `submitted_at` | TIMESTAMPTZ | |
| `retry_count` | INTEGER | Bounded retries; max 3 before `FAILED` |
| `scheduled_not_before` | TIMESTAMPTZ | Ashby rate-limit timestamp (Migration **036/037**) |
| `error_message` | TEXT | |
| `error_details` | JSONB | Structured failure diagnostics (Migration **027**) |
| UNIQUE | | `task_id` (when present); generated legacy key when `task_id` IS NULL |


### `gh_ai_answer_reviews` (Migration 048)
| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | Primary review record identifier |
| `application_id` | UUID FK | References `gh_candidate_applications` |
| `resolution_revision` | INTEGER | Resolution generation number |
| `field_key` | TEXT | 16-char SHA-256 fingerprint |
| `applywizz_id` | TEXT FK | References `profiles` |
| `candidate_name` | TEXT | Human-readable candidate name snapshot |
| `question_label` | TEXT | Form question label |
| `field_type` | TEXT | Field input type |
| `options` | JSONB | Scanned choice options |
| `ai_value` | TEXT | Original Tier 5 synthesized value |
| `ai_confidence` | FLOAT | Model confidence score |
| `ai_model` | TEXT | Winning model identity |
| `ai_provenance` | JSONB | Full escalation lineage and model attempts |
| `revision` | INTEGER | Optimistic concurrency revision counter |
| `status` | TEXT | `pending_operator` \| `pending_manager` \| `approved` \| `rejected` |
| `promoted_at` | TIMESTAMPTZ | Timestamp of operator submission promotion |
| `promoted_value` | TEXT | Value promoted to QA bank on submission |
| `promoted_source` | TEXT | `operator_submission` |
| `operator_action` | TEXT | `approved` \| `edited` \| `denied` |
| `operator_value` | TEXT | Value approved/edited by operator |
| `operator_email` | TEXT | Operator email who performed review |
| `manager_action` | TEXT | `approved` \| `edited` \| `rejected` |
| `manager_value` | TEXT | Final manager-confirmed/edited value |
| `manager_email` | TEXT | Manager email who completed review |
| `embedding_status` | TEXT | `pending` \| `completed` \| `failed` \| `not_applicable` |
| `embedding_revision` | INTEGER | Revision counter for vector embedding sync |
| UNIQUE | | `(application_id, resolution_revision, field_key)` |

### `gh_ai_answer_review_events` (Migration 048)
| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | Audit event identifier |
| `review_id` | UUID FK | References `gh_ai_answer_reviews` |
| `event_type` | TEXT | `promoted_submission` \| `operator_action` \| `manager_action` |
| `actor` | TEXT | Actor email |
| `actor_role` | TEXT | `operator` \| `manager` \| `admin` \| `dev` |
| `action` | TEXT | Specific action taken |
| `from_status`, `to_status` | TEXT | State transition boundaries |
| `from_revision`, `to_revision` | INTEGER | Revision transition boundaries |
| `payload` | JSONB | Contextual audit details |

### `gh_ai_review_idempotency_keys` (Migration 048)
| Column | Type | Notes |
|---|---|---|
| `key` | TEXT PK | Client idempotency UUID |
| `review_id` | UUID FK | References `gh_ai_answer_reviews` |
| `action_type` | TEXT | `operator_action` \| `manager_action` |
| `response_payload` | JSONB | Cached mutation receipt for replay safety |

### Supabase Storage Buckets
| Bucket | Path Pattern | Contents |
|---|---|---|
| `csv_uploads` | root-level `*.csv`; direct Admin uploads stage as `pending/{uuid}_{filename}.csv` and move to `archive/` after ingestion | Private CSV dropzone |
| `resumes` | `resumes/resume_{first_name}_{last_name}_{domain_shortcode}.pdf` | Candidate resume PDFs |
| `proofs_web` | `proofs/{app_id}_web.png` | Confirmation screenshots |
| `proofs_dry_run` | `dry-run/{app_id}_dryrun.png` | Dry-run screenshots |
| `proofs_failed` | `{app_id}_failed.png` | Failure screenshots |
| `proofs_mail` | `{app_id}_mail_proof.png` | Confirmation email screenshots |

### DB Migrations (SQL files, applied via `src/db/migrate.ts`)
- `001` company_email
- `002` captcha→otp_required rename
- `003` proof_email_url
- `004` optimization indexes
- `005` round-robin queue
- `006` email proof status
- `007` proof_failed_url
- `008` proof_email_json
- `009` email_proof_pending
- `010` Realtime on gh_candidate_applications
- `011` zoho_connected_profiles
- `012` approved status
- `013` email_unverified status
- `014` skipped status
- `015` gh_audit_events + gh_application_events + service_role RLS
- `016` profiles.country + country_code
- `017` gh_users
- `018` disable gh_users rls
- `019` application_submission_metadata
- `019b` application_retry_count
- `020` multi_service_state / retry_count
- `021` pgvector_semantic_search
- `022` unify_email_proof_pending_status
- `023` backfill_submitted_at
- `024` legacy stats_rollups
- `025` perf_indexes & retry_status
- `026` retry_status_repair
- `027` canonical application stats & error_details
- `028` repair cutover to earliest recorded fact
- `029` failure_diagnostics
- `030` remove_captcha_state
- `031` application_token_usage
- `032` filtered_out_status
- `033` add_profiles_resume_storage_path
- `034` candidate_round_robin_dequeue
- `035` application_task_id
- `036` ats_and_ashby_schedule
- `037` ashby_rate_limit_rpc
- `048` ai_answer_reviews (two-level review schema, review events, idempotency keys)
- `latest` combined

## Dashboard roles (email map — no DB)

`resolveRoleFromEmail()` in `src/server/routes/auth.ts` is the single source of truth. Case-insensitive. Missing email is never treated as admin.

| Role | Emails | Home | Can open |
|---|---|---|---|
| `dev` | `yaswanthnaiduyalla@applywizz.ai`, `vivek@applywizz.ai` | `/dev` | `/`, `/admin`, `/manager`, `/dev` (header switcher) |
| `admin` | `ramakrishna@applywizz.ai`, `anushabandreddy@applywizz.ai` | `/admin` | `/admin` only |
| `manager` | `balaji@applywizz.ai`, `ramakrishnaa.tejavath@applywizz.ai` | `/manager` | `/manager` only |
| `operator` | any other signed-up email | `/` | `/` only |

API guards: `/api/applications|candidates|notifications` → operator+dev; `/api/admin` → admin+dev; `/api/manager` → manager+dev; `/api/dev` → dev. Login returns `homePath`. CSV **▶ Start** lives on the Admin dashboard.

## Key Architectural Rules
1. **Never re-parse a resume** — always check `candidate_resume_parsed` before calling pdf-parse
2. **Always fingerprint questions** — never store answers by raw label string
3. **LLM is last resort** — Tiers 1–4 must all miss before Tier 5 fires
4. **Idempotent upserts everywhere** — pipeline is safe to re-run; no duplicate rows
5. **Supabase service key for data access** — Express uses `service_role`. Event tables enable RLS with `service_role`-only policies.
6. **RAILWAY_ENV=true** — disables headful mode, caps memory on Railway deployment
7. **Unified Browser Stealth** — all submissions (Greenhouse and Ashby) run through `BrowserManager` with `playwright-extra` stealth
8. **Stdout in `src/` goes through `createLogger`** (`src/utils/logger.ts`) — `[ISO timestamp] [LEVEL] [MODULE] message`
9. **`haltWithDevAlert` is for systemic ingest failures only** — Playwright launch, Supabase unreachable / empty key probe, ApplyWizz 5xx/timeout, required-migration missing table, first LLM provider call down, malformed/empty CSV
