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
MAX_JOB_QUESTIONS=23                  # Lift to 999 when < 23 restriction removed

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

On ingest, logs include `Credential identity: urlProjectRef=... | jwt.role=... | jwt.ref=... | urlRefMatch=...` (see `src/db/supabaseKeyDiagnostics.ts`) — never the raw key.

The server resolves credentials via `resolveSupabaseCredentials()` in `src/db/client.ts`: a JWT with `role=service_role` wins; otherwise **`SUPABASE_SERVICE_ROLE_KEY` is used even when it is a new `sb_secret_` key** (those have no JWT role claim — do not fall back to anon in `SUPABASE_SERVICE_KEY`). Typical Railway layout: anon/publishable in `SUPABASE_SERVICE_KEY`, secret in `SUPABASE_SERVICE_ROLE_KEY`. Startup logs `[Server] Credential identity (SUPABASE_SERVICE_ROLE_KEY): …`. Ingest lists `csv_uploads` **without** `sortBy created_at` and logs root names; an empty object list is a failed run, not “nothing to do”. Admin probe: `GET /api/admin/supabase-storage-health` (includes `csvUploadsListNames`).

The dashboard's **▶ Start** button (header, next to refresh — rendered only under `isAdminSession()`) calls both: POST, then polls the status endpoint every 5s and reloads candidate data when the run ends. CLI equivalent: `npm run ingest:storage` (one-shot, exits when done). Run state lives in server memory, so a restart mid-run loses the status (the pipeline itself dies with the process too).

## External Services & Endpoints
| Service | URL | Purpose |
|---|---|---|
| ApplyWizz API | `https://www.apply-wizz.me/api/get-client-details` | Candidate profile + resume |
| ApplyWizz S3 | `https://applywizz-prod.s3.us-east-2.amazonaws.com` | Resume PDF source |
| ApplyWizz CA Mgmt | `https://applywizz-ca-management.vercel.app/api/ca/work-history` | Work history API |
| Zoho Mail Reader | `https://zoho-mail-reader.onrender.com/` | OTP/email proof extraction |
| ↳ REST (used by `zoho-connector.ts`) | `GET /api/zoho/ui/inbox?email=&limit=&start=` · `GET /api/zoho/ui/message?email=&accountId=&folderId=&messageId=` | Confirmation-email JSON |
| ↳ Web UI (used by `zohoReader.ts`) | root `/` via Playwright | OTP lookup (login form → filter by email → "Read mails") |

**Zoho connector auth model:** mailbox access is **server-side OAuth per mailbox** — no client token or session cookie is sent, and none is returned (0 cookies is expected, not a bug). An unlinked mailbox responds `HTTP 400 {"error":"Mailbox not connected","hint":"Paste a Self Client code for this user first."}`. `ZOHO_CONNECTOR_USER` / `ZOHO_CONNECTOR_PASS` only drive the Playwright UI login, which is effectively cosmetic on this deployment.
| OpenRouter | `https://openrouter.ai/api/v1` | LLM inference |

## Key File Locations
| What | Path |
|---|---|
| Main entry / CLI | `src/index.ts` |
| Env schema (Zod) | `src/config/env.ts` |
| Supabase client | `src/db/client.ts` |
| Supabase key diagnostics (ingest logs) | `src/db/supabaseKeyDiagnostics.ts` |
| DB DDL | `src/db/schema.sql` |
| Migrations dir | `src/db/migrations/` |
| Form filler (largest file, 59KB) | `src/submitter/formFiller.ts` |
| Live submit engine (69KB) | `src/submitter/liveSubmit.ts` |
| Playwright scanner | `src/scanner/playwrightScanner.ts` |
| Answer resolver orchestrator | `src/resolver/answerResolver.ts` |
| LLM synthesizer | `src/resolver/llmSynthesizer.ts` |
| Express server | `src/server/index.ts` |
| **Operator UI (the one actually served)** | `dashboard/public/index.html` — inline Babel/JSX, served by the `app.get('*')` catch-all |
| Manager UI (static) | `dashboard/public/manager.html` → `GET /manager` |
| Bundled Akshitha demo | `src/dashboard/akshithaDemoFixtures.ts` |
| Searchable select tests | `tests/searchableSelect.test.ts` |
| All TypeScript types | `src/types/index.ts` |
