# Tech Context — Stack, Commands & Config

## Runtime
- **Node.js** ≥ 22.0.0
- **TypeScript** 5.7 (strict mode, ESM — `"type": "module"`)
- Compiled with `tsc`; dev-run with `tsx` (no compile step needed)

## Core Dependencies
| Package | Role |
|---|---|
| `playwright` | Headless/headful Chromium — scanning + form submission |
| `@supabase/supabase-js` | DB client (Postgres) + Storage (S3-compatible) |
| `zod` | Env schema validation (`src/config/env.ts`) |
| `dotenv` | Env loading |
| `express` | REST API server (port 3001) |
| `ws` | WebSocket real-time status push |
| `pdf-parse` | Resume PDF text extraction (Tier 2) |
| `fuse.js` | Fuzzy matching for qa_bank (Tier 3) |
| `csv-parser` / `fast-csv` | Streaming CSV ingestion |
| `openai` | OpenAI / OpenRouter LLM calls (Tier 5) |
| `@google/generative-ai` | Gemini LLM calls (Tier 5) |
| `axios` | HTTP client (ApplyWizz API, Zoho connector) |
| `react` / `react-dom` | Operator dashboard UI (React Native Web) |

## LLM Providers (Tier 5)
Configured via `LLM_PROVIDER` env var. Supported values:
- `openrouter` — recommended; uses `OPENROUTER_API_KEY` + `OPENROUTER_MODEL`
- `gemini` — uses `GEMINI_API_KEY`
- `openai` — uses `OPENAI_API_KEY`
- `ollama` — local Ollama instance (`llama3.1:latest` default) — **requires Ollama running locally**

Default in `.env.example`: `openrouter`. Default in code: `ollama` (local).

## Build & Run Commands
```bash
# Dev (no compile)
npm run dev                  # Full pipeline: scan → sync → resolve → dashboard
npm run start                # Same as dev
npm run start:sample         # Single candidate AWL-31428, max 10 jobs

# Individual pipeline steps
npm run scan                 # Branch 1 only: scan Greenhouse URLs
npm run sync:candidates      # Branch 2 sync only: fetch ApplyWizz profiles
npm run resolve              # Resolution only: run 5-tier waterfall
npm run dashboard            # Start Express dashboard server only
npm run daemon               # Start queue worker daemon

# Submission
npm run dry-run              # Headful fill via src/submitter/runUserApplication.ts (local demo, not dashboard API)
npm run submit               # Live submission CLI

# Database
npm run db:migrate           # Run all pending migrations
npm run db:backfill-company-email
npm run db:clear             # Clear candidate_qa_bank answers

# Build & Prod
npm run build                # tsc compile → dist/
npm run start:prod           # node dist/server/index.js
npm run daemon:prod          # node dist/submitter/queueWorker.js

# Tests
npm run test                 # e2e integration test
npm run typecheck            # src (tsc --noEmit) + dashboard tree
npm run typecheck:dashboard  # dashboard/**/*.tsx only (dashboard/tsconfig.json)

# Utilities
npm run demo:fixture-31428   # Sync demo fixture data for AWL-31428
npm run ingest:storage       # Ingest CSV from Supabase Storage
npm run scan:zoho-connected  # Scan Zoho-connected profiles
npm run delete:old-jobs      # Delete old jobs and applications
```

## CLI Pipeline Flags (`src/index.ts`)
```
--skip-migrate       Skip V1→V2 migration
--skip-scan          Skip Playwright job scanning
--skip-sync          Skip candidate profile sync
--skip-resolve       Skip 5-tier answer resolution
--skip-dashboard     Skip starting dashboard server
--candidate=AWL-XXXX Target single candidate (also: --candidateId, --applywizzId, -c)
--limit=N            Process only N candidates (dev/testing)
--maxJobs=N          Cap jobs per candidate
--applicationId=XXX  Target single application
--verbose / -v       Enable tier telemetry logging
--port=N             Override server port
--input=path         Override CSV input path
--output=path        Override output directory
```

## Headful dry-run CLI (`src/submitter/runUserApplication.ts`, `npm run dry-run`)

Pass flags after `--` so npm forwards them (e.g. `npm run dry-run -- --candidate=AWL-31428 --maxJobs=1`).

```
--candidate=AWL-XXXX   Load bundled fixture apps when AWL-31428 (akshithaDemoFixtures)
--applywizzId=AWL-XXXX Alias for --candidate
--maxJobs=1            With AWL-31428 and no --jobUrl: pick Prometheus job (U.S. sponsorship combobox)
--jobUrl=URL           Pin fixture app by URL substring
[positional URL]       Default PMG demo job if no candidate fixture
```

Dashboard dry-run uses `POST /api/applications/:id/dry-run` → `dryRun.ts` (Supabase application record, uploads screenshot to storage).

## Required Environment Variables
```env
# Core — required
SUPABASE_URL=
SUPABASE_SERVICE_KEY=              # Anon / publishable — browser (Realtime, dashboard template reads). Not service_role.
SUPABASE_SERVICE_ROLE_KEY=         # Service role — server DB/Storage only (resolveSupabaseCredentials)
SUPABASE_ANON_KEY=                 # Optional override for browser key (default: SUPABASE_SERVICE_KEY)
APPLYWIZZ_API_URL=                    # ApplyWizz candidate profile endpoint

# LLM — at least one required (based on LLM_PROVIDER)
LLM_PROVIDER=openrouter               # openrouter | gemini | openai | ollama
OPENROUTER_API_KEY=
OPENROUTER_MODEL=
GEMINI_API_KEY=
OPENAI_API_KEY=

# Server
PORT=3001
NODE_ENV=development
```

Dashboard sessions last **7 days**: login returns a Supabase `refreshToken`; `POST /api/auth/refresh` rotates it; `dashboard/public/roleAccess.js` stores it and refreshes access tokens before they expire. Sign in once after this change lands — older tokens in localStorage have no refresh token.

## Optional Environment Variables
```env
# Playwright tuning
PLAYWRIGHT_TIMEOUT=30000
WORKER_POOL_SIZE=4                    # Parallel scanner workers (default 3, max 10)
SCANNER_JITTER_MIN_MS=3000
SCANNER_JITTER_MAX_MS=6000

# Storage
INPUT_CSV_PATH=./greenhouse_only_applywizz_prod(in).csv
OUTPUT_DIR=./output
RESUMES_DIR=./resumes
MAX_JOB_QUESTIONS=35                  # Skip jobs with field_count >= this value (allows 0–34 fields)

# Supabase Storage bucket names
SUPABASE_STORAGE_BUCKET_RESUMES=resumes
SUPABASE_STORAGE_BUCKET_PROOFS=proofs_web

# Zoho Mail (email proof capture)
ZOHO_CONNECTOR_URL=https://zoho-mail-reader.onrender.com/
ZOHO_CONNECTOR_USER=
ZOHO_CONNECTOR_PASS=
ZOHO_READER_EMAIL=
ZOHO_READER_PASSWORD=

# Azure / MS365 (email sending + OTP)
AZURE_CLIENT_ID=
AZURE_CLIENT_SECRET=
MS365_TENANT_ID=
AZURE_TENANT_ID=
AZURE_SENDER_EMAIL=
AZURE_COMMUNICATION_ENDPOINT=

# ApplyWizz external endpoints
APPLYWIZZ_S3_BASE_URL=https://applywizz-prod.s3.us-east-2.amazonaws.com
AUTHORIZED_EMAILS_API=https://applywizz-ca-management.vercel.app/api/ca/emails
ALLOWED_SIGNUP_EMAILS=

# OpenRouter extra
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_HTTP_REFERER=https://apply-wizz.me

# Railway deployment
RAILWAY_ENV=true                      # Disables headful mode, caps memory
```

## Deployment
- **Platform:** Railway (single Docker service)
- **Dockerfile:** root `Dockerfile`
- **Config:** `railway.json`
- **Prod entry:** `node dist/server/index.js` only (`railway.json` → `deploy.startCommand`). There is **no** separate worker or ingest service — the submission daemon runs in-process inside the server when `ENABLE_QUEUE_WORKER=true`, otherwise nothing dequeues `QUEUED`. `npm run daemon:prod` exists for running it standalone but is not what Railway starts.
- **Key Railway constraint:** `RAILWAY_ENV=true` must be set — disables headful Playwright, caps memory

## CSV Ingestion Trigger (operator-driven)
There is **no** Supabase Storage webhook and **no** poller — a CSV appearing in the `csv_uploads` bucket does nothing on its own. The pipeline starts only when an operator triggers it:

| Endpoint | Behaviour |
|---|---|
| `POST /api/admin/trigger-ingest-from-storage` | Admin-only (`isUserAdmin`, 403 otherwise). `409` if a run is already in flight. Otherwise returns `202 {started, startedAt}` and runs `ingestCsvFromStorage()` in the background — the full pipeline takes minutes, so it must not be awaited in the request. |
| `GET /api/admin/ingest-status` | Admin-only. Returns `{running, startedAt, finishedAt, processedCount, processedFile, message, error}` for the most recent run. |

CSV `applywizz_id`s are the approval to fetch missing ApplyWizz profiles. Application rows are written only after a Supabase `profiles` row exists (`hasSupabaseProfile`); otherwise the `candidate_applications_applywizz_id_fkey` is skipped with a warn.

On ingest, logs include `Credential identity: urlProjectRef=... | jwt.role=... | jwt.ref=... | urlRefMatch=...` (see `src/db/supabaseKeyDiagnostics.ts`) — never the raw key.

The server resolves credentials via `resolveSupabaseCredentials()` / `listSupabaseKeyCandidates()` in `src/db/client.ts`: a JWT with `role=service_role` wins; otherwise **`SUPABASE_SERVICE_ROLE_KEY` is used even when it is `sb_secret_`**. Keys are normalized (trim, unwrap quotes, strip `Bearer`, strip JWT whitespace). Ingest **probes each key with a fresh client** and logs `Probe SUPABASE_… jwt.role=… entries=N names=…`. An empty object list is a failed run. Admin probe: `GET /api/admin/supabase-storage-health` returns `keyProbes[]` (no secrets). `sb_secret_` / anon keys still cannot list private `csv_uploads` — use the legacy `eyJ…` service_role JWT.

The dashboard's **▶ Start** button lives on the **Admin** dashboard (`dashboard/public/admin.html`, `/admin`). It calls POST `/api/admin/trigger-ingest-from-storage`, then polls `GET /api/admin/ingest-status`. CLI equivalent: `npm run ingest:storage` (one-shot, exits when done). Run state lives in server memory (`src/server/runtimeState.ts`), so a restart mid-run loses the status (the pipeline itself dies with the process too).

## External Services & Endpoints
| Service | URL | Purpose |
|---|---|---|
| ApplyWizz API | `https://www.apply-wizz.me/api/get-client-details` | Candidate profile + resume |
| ApplyWizz S3 | `https://applywizz-prod.s3.us-east-2.amazonaws.com` | Resume PDF source |
| ApplyWizz CA Mgmt | `https://applywizz-ca-management.vercel.app/api/ca/work-history` | Work history API |
| Zoho Mail Reader | `https://zoho-mail-reader.onrender.com/` | OTP/email proof extraction |
| ↳ REST (used by `zoho-connector.ts`) | `GET /api/zoho/ui/inbox?email=&limit=&start=` · `GET /api/zoho/ui/message?email=&accountId=&folderId=&messageId=` | Confirmation-email JSON |
| ↳ Web UI (used by `zohoReader.ts`) | root `/` via Playwright | OTP lookup: **goto root + clear filter** each time, then filter by email → "Read mails". Empty user list → one `page.reload()` retry |

**Zoho connector auth model:** mailbox access is **server-side OAuth per mailbox** — no client token or session cookie is sent, and none is returned (0 cookies is expected, not a bug). An unlinked mailbox responds `HTTP 400 {"error":"Mailbox not connected","hint":"Paste a Self Client code for this user first."}`. `ZOHO_CONNECTOR_USER` / `ZOHO_CONNECTOR_PASS` only drive the Playwright UI login, which is effectively cosmetic on this deployment.
| OpenRouter | `https://openrouter.ai/api/v1` | LLM inference |

## Key File Locations
| What | Path |
|---|---|
| Main entry / CLI | `src/index.ts` |
| Env schema (Zod) | `src/config/env.ts` |
| Central logger | `src/utils/logger.ts` — `[ISO] [LEVEL] [MODULE] message`; levels INFO/WARN/ERROR/DEBUG/HALT. `haltWithDevAlert(module, message, error?)` logs `[HALT]` + `🚨 DEV ACTION REQUIRED` and `process.exit(1)` for systemic ingest failures only |
| Supabase client | `src/db/client.ts` |
| Supabase key diagnostics (ingest logs) | `src/db/supabaseKeyDiagnostics.ts` |
| Empty-form hydration | `src/db/applicationFieldHydration.ts` |
| Over-cap SKIPPED upserts | `src/db/skippedApplications.ts` |
| Operator queue filters | `src/dashboard/candidateQueueFilter.ts` |
| DB DDL | `src/db/schema.sql` |
| Migrations dir | `src/db/migrations/` — **015** = `audit_events` + `application_events` + service_role-only RLS (applied 2026-09-15) |
| Audit / application events | `src/db/events.ts` — fail-closed if 015 tables missing |
| Manager/admin client rollup | `src/server/clientDashboard.ts` (`MANAGER_TEAM_SCOPE_ENABLED = false`) |
| Admin / Dev health probes | `src/server/healthSnapshot.ts` — ApplyWizz GET without id: HTTP 400 = reachable |
| Form filler (largest file, 59KB) | `src/submitter/formFiller.ts` |
| Live submit engine (69KB) | `src/submitter/liveSubmit.ts` |
| Playwright scanner | `src/scanner/playwrightScanner.ts` |
| Answer resolver orchestrator | `src/resolver/answerResolver.ts` |
| LLM synthesizer | `src/resolver/llmSynthesizer.ts` |
| Express server | `src/server/index.ts` |
| **Operator UI (the one actually served)** | `dashboard/public/index.html` — inline Babel/JSX, served at `GET /` |
| Manager UI | `dashboard/public/manager.html` → `GET /manager` |
| Admin UI | `dashboard/public/admin.html` → `GET /admin` |
| Dev UI | `dashboard/public/dev.html` → `GET /dev` |
| Shared role helper | `dashboard/public/roleAccess.js` — 7-day session via refresh_token; wraps `/api/` fetch |
| App logo / favicon | `dashboard/public/logo.webp` — served by `express.static(dashboard/public)` |
| Bundled Akshitha demo | `src/dashboard/akshithaDemoFixtures.ts` |
| Searchable select tests | `tests/searchableSelect.test.ts` |
| All TypeScript types | `src/types/index.ts` |
