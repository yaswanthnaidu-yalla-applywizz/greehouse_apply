# Tech Context — Stack, Commands & Config

## Runtime
- **Node.js** ≥ 22.0.0
- **TypeScript** 5.7 (strict mode, ESM — `"type": "module"`)
- Compiled with `tsc` + `vite build`; dev-run with `tsx` (no compile step needed)

## Core Dependencies
| Package | Role |
|---|---|
| `playwright` | Headless/headful Chromium — scanning + form submission |
| `playwright-extra` | Stealth Playwright wrapper for automated bot evasion |
| `puppeteer-extra-plugin-stealth` | Evasion plugin unified across `BrowserManager` |
| `@supabase/supabase-js` | DB client (Postgres) + Storage (S3-compatible) |
| `zod` | Env schema validation (`src/config/env.ts`) |
| `dotenv` | Env loading |
| `express` | REST API server (port 3000 / 3001) |
| `ws` | WebSocket real-time status push |
| `pdf-parse` | Resume PDF text extraction (Tier 2) |
| `fuse.js` | Fuzzy matching for qa_bank (Tier 4) |
| `csv-parser` / `fast-csv` | Streaming CSV ingestion |
| `openai` | OpenAI / OpenRouter LLM calls (Tier 5) |
| `@google/generative-ai` | Gemini LLM calls (Tier 5) |
| `@aws-sdk/client-bedrock-runtime` | AWS Bedrock Nova & Titan calls (Tier 5) |
| `axios` | HTTP client (ApplyWizz API, Zoho connector, Microsoft Graph) |
| `react` / `react-dom` | Operator dashboard UI (React 19 / TSX Vite bundle) |
| `vite` / `vitest` | Frontend bundler and test runner |

## LLM & Embedding Providers
- **Tier 5 Resolution**: Strictly uses `anthropic` (`CLAUDE_API_KEY`, `ANTHROPIC_WORKSPACE_ID`, `CLAUDE_MODEL` — defaults to `claude-haiku-5-5`). All multi-provider text-generation fallbacks (OpenRouter/Bedrock/Gemini) are purged from the resolver.
- **Tier 3 Semantic Search**: Strictly uses `openrouter` (`OPENROUTER_API_KEY` for `text-embedding-3-small` 1536-dim embeddings via `https://openrouter.ai/api/v1/embeddings`).

## Build & Run Commands
```bash
# Dev (no compile)
npm run dev                  # Full pipeline: scan → sync → resolve → dashboard
npm run start                # Same as dev
npm run start:sample         # Single candidate AWL-31428, max 10 jobs

# Individual pipeline steps
npm run scan                 # Branch 1 only: scan Greenhouse/Ashby URLs
npm run sync:candidates      # Branch 2 sync only: fetch ApplyWizz profiles
npm run resolve              # Resolution only: run 5-tier waterfall
npm run dashboard            # Start Express dashboard server only
npm run daemon               # Start queue worker daemon

# Submission
npm run dry-run              # Headful fill via src/submitter/runUserApplication.ts
npm run demo:doordash-headful # Headful DoorDash React-Select diagnostic
npm run submit               # Live submission CLI

# Database & Sandbox
npm run db:migrate           # Run all pending migrations (001–037)
npm run db:fix-rollup        # Inspect yesterday/today canonical stats
npm run backfill:profiles    # Refresh all Supabase profiles from ApplyWizz
npm run sandbox              # Run local Postgres sandbox environment (SANDBOX=true)
npm run sandbox:fresh        # Reset local sandbox Postgres database and start fresh pipeline

# Build & Prod
npm run build                # tsc compile → dist/ + Vite dashboard build
npm run build:dashboard      # vite build (dashboard TSX bundle)
npm run build:dashboard-css  # dashboard/public/dashboard.css via Tailwind
npm run start:prod           # node dist/server/index.js
npm run daemon:prod          # node dist/submitter/queueWorker.js

# Tests & Typecheck
npm run test                 # e2e integration test
npm run test:unit            # Node test runner + Vitest suite
npm run test:vitest          # Vitest unit test suite
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
--skip-migrate       Skip migration check
--skip-scan          Skip Playwright/Ashby job scanning
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

## Required Environment Variables
```env
# Core — required
SUPABASE_URL=
SUPABASE_SERVICE_KEY=              # Anon / publishable — browser (Realtime, dashboard template reads)
SUPABASE_SERVICE_ROLE_KEY=         # Service role — server DB/Storage only
SUPABASE_ANON_KEY=                 # Optional override for browser key
APPLYWIZZ_API_URL=                 # ApplyWizz candidate profile endpoint

# LLM — at least one required (based on LLM_PROVIDER)
LLM_PROVIDER=openrouter            # anthropic | openrouter | gemini | openai | ollama | bedrock
CLAUDE_API_KEY=
ANTHROPIC_WORKSPACE_ID=
CLAUDE_MODEL=claude-haiku-5-5
OPENROUTER_API_KEY=
OPENROUTER_MODEL=
GEMINI_API_KEY=
OPENAI_API_KEY=
LLM_TIMEOUT_MS=30000

# Server
PORT=3000
NODE_ENV=development
JWT_SECRET=
```

Dashboard sessions last **7 days**: login returns a Supabase `refreshToken`; `POST /api/auth/refresh` rotates it.

## Optional Environment Variables
```env
# Playwright & Concurrency
PLAYWRIGHT_TIMEOUT=30000
WORKER_POOL_SIZE=4                 # Parallel scanner workers (default 3, max 10)
RESOLVER_WORKER_POOL_SIZE=3        # Parallel candidate×job resolution workers during ingest
SUBMISSION_POOL_SIZE=3             # Submitter worker pool concurrency
MAX_CONCURRENT_BROWSERS=5          # Maximum concurrent live Chromium browser instances
BROWSER_LAUNCH_COOLDOWN_MS=1500    # Spacing between consecutive browser launches
SCANNER_JITTER_MIN_MS=3000
SCANNER_JITTER_MAX_MS=6000

# Storage & Filters
INPUT_CSV_PATH=./greenhouse_only_applywizz_prod(in).csv
OUTPUT_DIR=./output
RESUMES_DIR=./resumes
MAX_JOB_QUESTIONS=35               # Jobs with 35+ scanned questions are skipped
SUPABASE_STORAGE_BUCKET_RESUMES=resumes
SUPABASE_STORAGE_BUCKET_PROOFS=proofs_web

# DataImpulse Residential Proxy (Ashby)
DATAIMPULSE_LOGIN=
DATAIMPULSE_PASSWORD=
DATAIMPULSE_HOST=gw.dataimpulse.com
DATAIMPULSE_PORT=823

# Zoho Mail Connector (OTP & Confirmation Proofs)
ZOHO_CONNECTOR_URL=https://zoho-mail-reader.onrender.com/
ZOHO_CONNECTOR_USER=
ZOHO_CONNECTOR_PASS=
OTP_RESOLUTION_POLL_INTERVAL_MS=10000
OTP_ATTEMPT_TIMEOUT_MS=60000

# Azure / Microsoft Graph (Notifications & SLA Poller)
AZURE_CLIENT_ID=
AZURE_CLIENT_SECRET=
AZURE_TENANT_ID=
AZURE_SENDER_EMAIL=
MS_GRAPH_BASE_URL=https://graph.microsoft.com

# CA-Candidate Ingestion Mapping
CA_MAPPING_API_URL=                  # Optional external endpoint returning daily CA-to-candidate assignments (falls back to admin work-history)
CA_NOTIFICATION_EMAIL_OVERRIDE=    # Redirect all CA/leadership emails to single address

# AWS Bedrock (if LLM_PROVIDER=bedrock)
AWS_REGION=us-east-1
BEDROCK_MODEL_ID=us.amazon.nova-2-lite-v1:0
BEDROCK_API_KEY=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=

# Railway deployment & Service Architecture
RAILWAY_ENV=true                   # Disables headful mode, caps memory
ENABLE_PIPELINE_STOP=false         # Allow admin ⏹ Stop + CLI SIGINT
INGEST_ONLY=false                  # Start server in ingest-only mode
WEB_SERVICE_URL=                   # Main web service URL for ingest/worker WebSocket event forwarding
DASHBOARD_MODE=tsx                 # 'tsx' (Vite build dist/client) or 'html' (Babel in-browser legacy)
PIPELINE_VERBOSE=false             # Compact pipeline summaries vs verbose logs

# Local Sandbox Mode
SANDBOX=true                       # Run with local PostgreSQL container
```

## Deployment
- **Platform:** Railway (single Docker service)
- **Prod URL:** https://gh.applywizz.ai (project `alert-spontaneity`, service `greehouse_apply`, region `sfo`)
- **Dockerfile:** root `Dockerfile`
- **Config:** `railway.json` (healthcheck `GET /api/health`, start `node dist/server/index.js`)
- **Prod entry:** `node dist/server/index.js` only. Daemon runs in-process inside server when enabled.
- **Key Railway constraint:** `RAILWAY_ENV=true` must be set — disables headful Playwright, caps memory.

### AI ops — Railway & Supabase (MCP)
- Use authenticated **Railway** and **Supabase MCP** tools for logs, deploy status, SQL, and table reads. Avoid CLI commands in production unless MCP is unavailable.
