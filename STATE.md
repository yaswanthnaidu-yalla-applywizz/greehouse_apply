# Project State — Greenhouse Job Application Automation V1

## Current Phase
V1-3: Branch 2 — Candidate Segregation & ApplyWizz Profile Sync

## Phase Status
COMPLETED

## What's Done
- Phase V1-1: Node.js / TypeScript environment initialized with strict mode (`tsconfig.json`, `package.json`)
- Domain types and data contracts declared (`src/types/index.ts`) matching `05-backend-schema.md`
- Typed environment variable validator with Zod and dotenv (`src/config/env.ts`, `.env.example`)
- Phase V1-2: CSV Deduplicator (`src/scanner/csvDeduplicator.ts`) with stream-parsing, tracking param stripping (`gh_src`, `utm_*`), and fast concurrent HTTP resolution of `grnh.se` shortlinks
- Phase V1-2: Playwright Scanner (`src/scanner/playwrightScanner.ts`) with configurable worker pool, randomized 3-6s jitter, dual modern Remix state and deep DOM inspection, comprehensive standard/custom field extraction, select/radio option harvesting, and 404/expired job detection
- Phase V1-2: Scanned Job Exporter (`src/scanner/exportScannedJobs.ts`) writing full structured JSON (`output/scanned_jobs.json`) and flattened CSV (`output/scanned_jobs.csv`)
- Phase V1-2: Scanner CLI runner (`src/scanner/runScan.ts`) and barrel re-exports (`src/scanner/index.ts`, `src/index.ts`, `package.json` scan script)
- Phase V1-3: ApplyWizz API Client (`src/candidate/applywizzClient.ts`) with 3x exponential backoff retry, schema normalizer, local JSON profile caching (`./cache/profiles/`), and master PDF resume downloader (`./resumes/`)
- Phase V1-3: Candidate Segregator (`src/candidate/segregator.ts`) stream-parsing input CSV by `Applywizz ID`, batch profile synchronization, and segment export (`output/candidate_segments.json`)
- Phase V1-3: Candidate sync CLI runner (`src/candidate/runCandidateSync.ts`) and barrel re-exports (`src/candidate/index.ts`, `src/index.ts`, `package.json` `sync:candidates` script)

## What's In Progress
- Ready for Phase V1-4: Answer Resolution Engine (`supabase` vs `ai` Tagging)
- Blockers: None

## What's Next
- V1-4: Answer Resolution Engine (`src/resolver/profileMatcher.ts`, `src/resolver/llmSynthesizer.ts`, `src/resolver/answerResolver.ts`)

## Latest Commit
2026-09-04 | V1-3
Branch 2 Candidate Segregation and ApplyWizz API Profile Sync completed
