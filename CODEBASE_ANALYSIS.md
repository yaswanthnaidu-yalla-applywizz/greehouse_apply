# Codebase Technical Analysis & Living Architecture Map

**Project:** Greenhouse Job Application Automation (V1)  
**Repository:** `yaswanthnaidu-yalla-applywizz/greehouse_apply`  
**Current State:** Phase V1-6 Completed (End-to-End Master Pipeline & Verification Suite)  
**Last Updated:** 2026-09-04  

---

## 1. Executive Summary

The **Greenhouse Job Application Automation System (V1)** is an industrial-grade, multi-tenant operator platform designed to eliminate the manual bottleneck of high-volume job applications on Greenhouse ATS boards (`boards.greenhouse.io`, `job-boards.greenhouse.io`, `app.greenhouse.io/embed/...`, and `grnh.se/...` shortlinks).

The system implements an asynchronous, decoupled **Two-Branch Architecture**:
1. **Branch 1 (Unique Link Processing & Headless DOM Scanning):** Deduplicates raw job postings from an input batch CSV (`greenhouse_only_applywizz_prod(in).csv`), strips marketing tracking parameters, resolves HTTP redirects/shortlinks, and utilizes a configurable Playwright worker pool (with 3–6s randomized jitter) to scrape form field schemas, input types, required flags, select/radio options, and detect 404/expired jobs *exactly once per unique URL*, persisting results to `output/scanned_jobs.json` and `output/scanned_jobs.csv`.
2. **Branch 2 (Candidate Segregation & Tagged Answer Resolution):** Segregates records by candidate `Applywizz ID`, synchronizes rich candidate profiles and master PDF resumes via the ApplyWizz API (with exponential backoff and local disk caching), applies a **Question Count Gating Filter (`< 23` questions)** to stream only "Easy" jobs into the initial active queue, and resolves all application questions using a multi-tier resolution engine with strict source attribution:
   - **`supabase`** for direct/fuzzy matches against candidate profile attributes and persistent candidate Q&A bank (`./cache/qa_bank/`).
   - **`ai`** for LLM-synthesized responses (OpenRouter / Google Gemini / OpenAI) combining candidate profile, resume context, and job metadata.

Pre-populated job applications (< 23 questions) and aggregated metrics are served via an Express REST API backend to a responsive React Split-Screen Operator Dashboard for instantaneous review, queue management, and candidate directory filtering. Complex applications ($\ge 23$ questions) are preserved in the scanned archive for post-master-goal expansion. The full pipeline is coordinated end-to-end via `V1Pipeline` and verified with a 6-checkpoint automated test suite.

---

## 2. Repository Structure

```
greehouse_apply/
├── .env                                       # Local environment variable configuration
├── .env.example                               # Environment template with provider defaults
├── .gitignore                                 # Git ignore definitions (node_modules, dist, cache, etc.)
├── package.json                               # Dependencies, scripts (pipeline, scan, sync, resolve, dashboard, test)
├── package-lock.json                          # Pinned dependency tree lockfile
├── tsconfig.json                              # TypeScript strict compiler configuration (ES2022 / NodeNext)
├── STATE.md                                   # Living project state and phase completion tracking
├── CODEBASE_ANALYSIS.md                       # Living technical architectural map and codebase specification
├── greenhouse_only_applywizz_prod(in).csv      # Production input CSV dataset (16.2 MB, ~73k rows)
│
├── project docs/                              # Project technical specifications and requirements
│   ├── 01-prd.md                              # Product Requirements Document
│   ├── 02-trd.md                              # Technical Requirements Document
│   ├── 03-workflow.md                         # Dual-branch workflow, sequence flows & edge cases
│   ├── 04-ui-ux.md                            # Split-screen dashboard UI/UX design specification
│   ├── 05-backend-schema.md                   # Data schemas and Supabase migration DDL
│   ├── 06-implementation.md                  # Phased build roadmap and verification checkpoints
│   ├── AGENTS.md                              # Coding conventions, tool rules, and state protocols
│   ├── MASTER_GOAL.md                         # Master Vision document (V1, V2+, V3 roadmap)
│   └── requirement_interview_for_context_persistence.md # Requirement transcript & context log
│
├── src/                                       # Core TypeScript application source code (~3,800 LOC)
│   ├── index.ts                               # Application bootstrap, subsystem status banner, and re-exports [~60 lines]
│   ├── config/
│   │   └── env.ts                             # Environment parsing, Zod validation, and active LLM key resolution [~121 lines]
│   ├── types/
│   │   └── index.ts                           # Comprehensive TypeScript domain types and data contracts [~305 lines]
│   ├── scanner/                               # Branch 1: Link processing and Playwright scanning engine
│   │   ├── csvDeduplicator.ts                 # Stream-parsing, URL sanitization & grnh.se concurrent resolution [~301 lines]
│   │   ├── playwrightScanner.ts               # Worker pool, DOM/Remix state extractor & 404 detector [~718 lines]
│   │   ├── exportScannedJobs.ts               # Structured JSON and flattened CSV template serializer [~143 lines]
│   │   ├── runScan.ts                         # Standalone CLI execution runner for Branch 1 [~103 lines]
│   │   └── index.ts                           # Scanner module barrel export [~7 lines]
│   ├── candidate/                             # Branch 2: Candidate segregation and profile sync
│   │   ├── applywizzClient.ts                 # ApplyWizz API client, 3x backoff retry & PDF resume downloader [~357 lines]
│   │   ├── segregator.ts                      # CSV row grouper, batch synchronizer & segment exporter [~242 lines]
│   │   ├── runCandidateSync.ts                # Standalone CLI execution runner for candidate sync [~106 lines]
│   │   └── index.ts                           # Candidate module barrel export [~5 lines]
│   ├── resolver/                              # Answer resolution engine (Multi-tier 'supabase' vs 'ai')
│   │   ├── profileMatcher.ts                  # Tier 1 direct/fuzzy matcher (Fuse.js >= 0.85) -> 'supabase' [~394 lines]
│   │   ├── llmSynthesizer.ts                  # Tier 2 LLM prompt synthesizer (OpenRouter/Gemini/OpenAI) -> 'ai' [~296 lines]
│   │   ├── qaBank.ts                          # Persistent candidate Q&A bank in ./cache/qa_bank/ [~156 lines]
│   │   ├── answerResolver.ts                  # Multi-tier resolution orchestrator & export serializer [~261 lines]
│   │   ├── runResolver.ts                     # Standalone CLI execution runner for answer resolution [~104 lines]
│   │   └── index.ts                           # Resolver module barrel export [~7 lines]
│   ├── server/                                # Backend presentation REST API
│   │   └── index.ts                           # Express REST API (candidates, jobs, stats, resumes, artifacts) [~445 lines]
│   └── orchestrator/                          # Master End-to-End Pipeline Orchestration
│       ├── pipeline.ts                        # Master V1Pipeline class coordinating all subsystems [~262 lines]
│       ├── runPipeline.ts                     # Standalone CLI runner with parameter flags [~76 lines]
│       └── index.ts                           # Orchestrator barrel export [~6 lines]
│
├── dashboard/                                 # Frontend Operator Dashboard (~1,280 LOC)
│   ├── App.tsx                                # Root split-screen container and state manager [~211 lines]
│   ├── CandidateList.tsx                      # Left pane: Candidate directory, search, filter, status badges [~149 lines]
│   ├── JobQueueView.tsx                       # Right pane top: Tabbed candidate job queue & status switcher [~120 lines]
│   ├── FormRenderer.tsx                       # Right pane bottom: Tagged Q&A viewer (green 'supabase' / purple 'ai') [~209 lines]
│   ├── types.ts                               # Dashboard frontend interface contracts [~60 lines]
│   └── public/
│       └── index.html                         # Standalone HTML bundle with React 18 CDN, Tailwind CSS & embedded app [~548 lines]
│
├── tests/                                     # Automated test suites
│   └── e2e.test.ts                            # Comprehensive 6-checkpoint End-to-End integration test suite [~216 lines]
│
├── output/                                    # Generated intermediate artifacts
│   ├── scanned_jobs.json                      # Unique scanned job form templates (JSON) [~28 KB]
│   ├── scanned_jobs.csv                       # Flattened scanned form questions (CSV) [~23 KB]
│   ├── candidate_segments.json                # Segregated candidate profiles and mapped jobs [~232 KB]
│   └── resolved_applications.json             # Pre-filled job applications with source-tagged fields [~98 KB]
│
├── cache/                                     # Persistent local caching layer
│   ├── profiles/                              # Cached candidate profile JSONs (`${applywizzId}_profile.json`)
│   └── qa_bank/                               # Cached candidate Q&A records (`${applywizzId}_qa.json`)
│
└── resumes/                                   # Downloaded candidate master resumes
    └── [applywizzId]_resume.pdf               # Candidate-isolated resume PDF binaries
```

---

## 3. Tech Stack

| Layer / Component | Technology | Version | Purpose |
| :--- | :--- | :--- | :--- |
| **Runtime & Language** | **Node.js / TypeScript** | `v20+` / `^5.7.3` | Modern asynchronous I/O runtime with strict compiler options and ES module resolution. |
| **Browser Automation Engine** | **Playwright (`playwright`)** | `^1.50.1` | Headless Chromium pool for DOM traversal, iframe embed inspection, and Remix state hydration extraction. |
| **CSV Parsing & Streaming** | **`fast-csv` / `csv-parser`** | `^5.0.3` / `^3.2.0` | High-throughput streaming parser and serializer for bulk CSV files (>70k rows) with low memory footprint. |
| **HTTP Client & Retry** | **Axios (`axios`)** | `^1.7.9` | HTTP client querying ApplyWizz API with exponential backoff and streaming binary PDF downloads. |
| **Fuzzy Matching Engine** | **Fuse.js (`fuse.js`)** | `^7.1.0` | In-memory fuzzy string matching for candidate profile keys to form labels ($\ge 0.85$ threshold). |
| **AI / LLM Providers** | **OpenRouter / Google Gemini / OpenAI** | `@google/generative-ai` `^0.24.0`<br>`openai` `^4.86.1` | Free-tier OpenRouter (`nvidia/nemotron-3-ultra-550b-a55b:free`), Gemini 1.5/2.0 Flash, and OpenAI GPT-4o-mini for answering custom questions. |
| **Backend REST API Server** | **Express.js (`express`, `cors`)** | `^4.21.2` / `^2.8.5` | REST API serving candidate directory, job applications, system statistics, and resume static files. |
| **Operator Dashboard** | **React / React-DOM / Tailwind CSS** | `^19.2.8` | Split-screen operator UI with real-time candidate search, job tabs, and visual source badges. |
| **Configuration Validation** | **Zod (`zod`) / `dotenv`** | `^3.24.2` / `^16.4.7` | Type-safe environment variable schema validation and fallback resolution. |
| **Development & Execution** | **`tsx` / `ts-node`** | `^4.19.3` / `^10.9.2` | Fast TypeScript execution for CLI scripts, background workers, and E2E test runners. |

---

## 4. Environment Variables

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `PORT` | Optional | `3001` | HTTP port for the Express REST API and Operator Dashboard. |
| `NODE_ENV` | Optional | `development` | Runtime environment (`development`, `production`, `test`). |
| `APPLYWIZZ_API_URL` | Optional | `https://www.apply-wizz.me/api` | Base URL for the ApplyWizz candidate details REST endpoint. |
| `LLM_PROVIDER` | Optional | `openrouter` | Selected LLM provider (`openrouter`, `gemini`, `openai`). |
| `OPENROUTER_API_KEY` | Optional* | — | API key for OpenRouter (*recommended provider). |
| `OPENROUTER_MODEL` | Optional | `nvidia/nemotron-3-ultra-550b-a55b:free` | Model identifier for OpenRouter synthesis. |
| `GEMINI_API_KEY` | Optional* | — | Google Gemini API key for `@google/generative-ai` SDK. |
| `OPENAI_API_KEY` | Optional* | — | OpenAI API key for `openai` SDK. |
| `LLM_API_KEY` | Optional | — | Generic API key fallback for LLM synthesis. |
| `PLAYWRIGHT_TIMEOUT` | Optional | `30000` | Browser navigation and element selector timeout in milliseconds. |
| `WORKER_POOL_SIZE` | Optional | `4` | Number of parallel browser worker pages in the Playwright scanner pool (range: 1–10). |
| `SCANNER_JITTER_MIN_MS` | Optional | `3000` | Minimum randomized delay (ms) between consecutive page requests per worker. |
| `SCANNER_JITTER_MAX_MS` | Optional | `6000` | Maximum randomized delay (ms) between consecutive page requests per worker. |
| `INPUT_CSV_PATH` | Optional | `./greenhouse_only_applywizz_prod(in).csv` | Default path to the input CSV file. |
| `OUTPUT_DIR` | Optional | `./output` | Output directory for intermediate JSON and CSV artifacts. |
| `RESUMES_DIR` | Optional | `./resumes` | Local directory for downloaded candidate master PDF resumes. |

---

## 5. Data Flow Summary

```mermaid
flowchart TD
    CSVIn([1. Ingestion: greenhouse_only_applywizz_prod.csv]) --> B1_Dedupe[Branch 1: CSV Deduplicator\n- Strip utm/gh_src\n- Resolve grnh.se shortlinks]
    CSVIn --> B2_Segregate[Branch 2: Candidate Segregator\n- Group by Applywizz ID\n- Batch sync profiles]

    %% Branch 1: Scanner Pipeline
    subgraph B1_Pipeline [Branch 1: Unique Link Form Scanning Engine]
        B1_Dedupe --> B1_Unique[Unique Canonical URLs]
        B1_Unique --> B1_Scanner[Playwright Scanner Pool: 3-5 Workers\n- 3-6s Random Jitter\n- Remix State & DOM Extraction\n- 404 / Expired Detection]
        B1_Scanner --> B1_Export[Exporter: exportScannedJobs\n- output/scanned_jobs.json\n- output/scanned_jobs.csv]
    end

    %% Branch 2: Candidate Sync Pipeline
    subgraph B2_Pipeline [Branch 2: Candidate Segregation & Profile Sync]
        B2_Segregate --> B2_Client[ApplyWizz API Client\n- 3x Exponential Backoff\n- Cache in ./cache/profiles/\n- Download ./resumes/*.pdf]
        B2_Client --> B2_Segments[Candidate Segments Export\n- output/candidate_segments.json]
    end

    %% Answer Resolution Engine
    subgraph Resolver_Pipeline [Multi-Tier Answer Resolution Engine]
        B1_Export --> AnswerResolver[Answer Resolver Orchestrator]
        B2_Segments --> AnswerResolver
        
        AnswerResolver --> T1_Match{Tier 1: ProfileMatcher\nDirect & Fuzzy Match >= 0.85}
        T1_Match -->|Match Found| Tag_Supabase[Populate Answer\nTag: 'supabase'\nConfidence: 0.95 - 1.0]
        
        T1_Match -->|No Match| QABank_Check{Check Persistent\nCandidate Q&A Bank\n./cache/qa_bank/}
        QABank_Check -->|Cached| Tag_Supabase
        
        QABank_Check -->|Not Cached| T2_LLM[Tier 2: LLMSynthesizer\n- OpenRouter / Gemini / OpenAI\n- Prompt: Profile + Resume + Job Context\n- Align to select/radio options]
        T2_LLM --> Tag_AI[Populate Answer\nTag: 'ai'\nConfidence: 0.80 - 0.90]
        
        Tag_Supabase --> Save_QABank[Persist Answer to Q&A Bank]
        Tag_AI --> Save_QABank
        Save_QABank --> Resolved_Export[Export: exportResolvedApplications\n- output/resolved_applications.json]
    end

    %% Presentation & Dashboard
    subgraph Presentation_Layer [Presentation & Operator Dashboard]
        Resolved_Export --> Express_API[Express REST API Server\n- Port 3001\n- /api/candidates\n- /api/candidates/:id\n- /api/stats\n- Static Resumes]
        Express_API --> Dashboard_UI[Split-Screen Operator Dashboard\n- Left: Candidate Directory & Filters\n- Right Top: Job Queue Tabs\n- Right Bottom: Tagged Form Viewer\n  🟢 supabase badge | 🟣 ai badge]
    end

    %% Orchestration & Verification
    subgraph Orchestration [Master Orchestrator & Test Suite]
        V1Pipeline_Class[V1Pipeline Master Orchestrator] -.-> B1_Pipeline
        V1Pipeline_Class -.-> B2_Pipeline
        V1Pipeline_Class -.-> Resolver_Pipeline
        E2E_Test[tests/e2e.test.ts\n6 Verification Checkpoints] -.-> V1Pipeline_Class
        E2E_Test -.-> Express_API
    end
```

---

## 6. Module Deep Dives

### 6.1 `src/config/env.ts`
- **Role:** Loads, parses, validates, and exports the strongly-typed runtime configuration object.
- **Key Functions/Objects:**
  - `config`: Frozen configuration object with validated defaults.
  - `resolveLlmApiKey()`: Prioritizes active LLM API keys (`LLM_API_KEY` -> provider specific key -> cross-provider fallback).
- **Invariants:** Throws descriptive formatted errors at startup if configuration is invalid; enforces non-negative jitter and positive timeouts.

### 6.2 `src/types/index.ts`
- **Role:** Central type contract definition for all subsystem inputs, intermediate artifacts, and outputs.
- **Key Interfaces:**
  - `ScannedField`, `ScannedJobTemplate`: DOM question definitions and options.
  - `ApplyWizzProfile`, `CandidateEducation`, `CandidateWorkExperience`, `CandidateDemographics`: Candidate data model.
  - `CandidateSegment`, `CandidateJobRecord`: Grouped candidate application batches.
  - `ResolvedField`, `CandidateJobApplication`: Source-attributed (`supabase` vs `ai`) question responses.
  - `InputJobRow`: Raw CSV record structure.
- **Invariants:** TypeScript strict mode; zero `any` types.

### 6.3 `src/scanner/csvDeduplicator.ts`
- **Role:** Stream-parses CSV files, strips marketing parameters, normalizes URLs, resolves `grnh.se` shortlinks concurrently, and yields unique canonical job URLs.
- **Key Functions:**
  - `normalizeGreenhouseUrl(rawUrl: string): string`: Strips `gh_src`, `utm_*`, `ref`, and normalizes pathnames.
  - `resolveShortlink(shortUrl: string): Promise<string>`: Performs fast HTTP redirect resolution with local cache.
  - `resolveShortlinksBatch(shortUrls: string[], concurrency = 25): Promise<Map<string, string>>`: Bounded concurrent shortlink resolver.
  - `readAndDeduplicateUrls(csvPath: string, options?: DeduplicatorOptions): Promise<string[]>`: Full CSV deduplication pipeline.

### 6.4 `src/scanner/playwrightScanner.ts`
- **Role:** Headless Playwright worker pool executing parallel DOM inspection, Remix state extraction, option harvesting, and 404/expired posting detection.
- **Key Functions / Classes:**
  - `PlaywrightScanner`: Manages browser lifecycle, concurrency pool, and worker task queues.
  - `scanJobUrl(page: Page, jobUrl: string): Promise<ScannedJobTemplate>`: Navigates with 3–6s randomized jitter, inspects iframe/standard DOM or Remix context (`window.__remixContext`), and extracts form controls, labels, options, and required statuses.
  - `extractRemixFormState(page: Page)`: Evaluates client-side React/Remix hydration state to instantly extract questions if rendered dynamically.
  - `isExpiredJob(content: string, status: number): boolean`: Matches known Greenhouse expiration and closing notices.

### 6.5 `src/scanner/exportScannedJobs.ts`
- **Role:** Serializes scanned templates into `output/scanned_jobs.json` and flattened `output/scanned_jobs.csv`.
- **Key Functions:**
  - `exportScannedJobs(templates: ScannedJobTemplate[], outputDir?: string): Promise<ExportResult>`: Formats and writes JSON and CSV files using `fast-csv`.

### 6.6 `src/scanner/runScan.ts` & `src/scanner/index.ts`
- **Role:** CLI runner and barrel re-export for executing Branch 1 directly (`npm run scan`).

### 6.7 `src/candidate/applywizzClient.ts`
- **Role:** Queries ApplyWizz API (`/get-client-details`), normalizes responses, caches profile JSONs to `./cache/profiles/`, and streams master PDF resumes to `./resumes/${applywizzId}_resume.pdf`.
- **Key Functions / Classes:**
  - `ApplyWizzClient`: Axios wrapper with exponential backoff (up to 3 retries), local file caching, and binary PDF streaming.
  - `fetchCandidateProfile(applywizzId: string, forceRefresh?: boolean): Promise<ApplyWizzCandidateProfile>`: Fetches and parses candidate data.
  - `downloadResume(applywizzId: string, resumeUrl: string): Promise<string>`: Streams remote PDF to disk with size validation.

### 6.8 `src/candidate/segregator.ts`
- **Role:** Stream-parses CSV records, aggregates rows by candidate `Applywizz ID`, coordinates batch profile synchronization via `ApplyWizzClient`, and exports `output/candidate_segments.json`.
- **Key Functions:**
  - `segregateCandidatesByApplyWizzId(csvPath?: string, options?: SegregatorOptions): Promise<Map<string, CandidateSegment>>`: Ingestion grouper.
  - `exportCandidateSegments(segments: CandidateSegment[] | Map<string, CandidateSegment>, outputDir?: string): Promise<string>`: JSON serializer.

### 6.9 `src/candidate/runCandidateSync.ts` & `src/candidate/index.ts`
- **Role:** CLI runner and barrel re-export for executing candidate synchronization directly (`npm run sync:candidates`).

### 6.10 `src/resolver/profileMatcher.ts`
- **Role:** Tier 1 resolution engine matching candidate profile attributes against form questions via exact dictionary lookups and Fuse.js fuzzy matching ($\ge 0.85$).
- **Key Functions / Classes:**
  - `ProfileMatcher`: Contains mapping rules for contact info, LinkedIn, GitHub, work authorization, visa sponsorship, education, work history, and demographic surveys (gender, race, veteran, disability).
  - `resolveFromProfile(field: ScannedField, profile: ApplyWizzCandidateProfile): ResolvedField | null`: Returns resolved field tagged with `source: 'supabase'` and confidence score $\ge 0.95$.

### 6.11 `src/resolver/llmSynthesizer.ts`
- **Role:** Tier 2 resolution engine invoking OpenRouter (Nemotron), Google Gemini, or OpenAI to synthesize responses for behavioral and open-ended questions using candidate profile and job description context.
- **Key Functions / Classes:**
  - `LLMSynthesizer`: Multi-provider LLM caller with prompt assembly, JSON extraction, option alignment (`alignToOption`), and deterministic fallbacks.
  - `synthesizeAnswer(field: ScannedField, profile: ApplyWizzCandidateProfile, jobContext: JobContext, resumeText?: string): Promise<ResolvedField>`: Synthesizes answer tagged with `source: 'ai'`.

### 6.12 `src/resolver/qaBank.ts`
- **Role:** Manages persistent candidate Q&A store in `./cache/qa_bank/${applywizzId}_qa.json` to reuse resolved answers across recurring job applications.
- **Key Functions / Classes:**
  - `QABank`: In-memory and on-disk JSON cache with normalized question key hashing.
  - `getAnswer(applywizzId: string, label: string, fieldId: string): ResolvedField | null`: Retrieves previously answered question.
  - `saveAnswer(applywizzId: string, field: ResolvedField): void`: Persists newly resolved question.

### 6.13 `src/resolver/answerResolver.ts`
- **Role:** Orchestrates the resolution workflow across scanned job templates and segregated candidates, applying Tier 1 matching, Q&A cache retrieval, and Tier 2 LLM synthesis.
- **Key Functions / Classes:**
  - `AnswerResolver`: High-level resolution coordinator.
  - `resolveJobApplication(applywizzId: string, candidateProfile: ApplyWizzCandidateProfile, scanTemplate: ScannedJobTemplate, resumeText?: string): Promise<CandidateJobApplication>`: Resolves all fields for a single job.
  - `resolveBatch(segments: CandidateSegment[], templates: ScannedJobTemplate[]): Promise<CandidateJobApplication[]>`: Resolves all candidates and jobs.
  - `exportResolvedApplications(applications: CandidateJobApplication[], outputDir?: string): Promise<string>`: Writes `output/resolved_applications.json`.

### 6.14 `src/resolver/runResolver.ts` & `src/resolver/index.ts`
- **Role:** CLI runner and barrel re-export for executing answer resolution directly (`npm run resolve`).

### 6.15 `src/server/index.ts`
- **Role:** Express REST API server providing operator endpoints, pipeline metrics, and serving the React dashboard.
- **Key Endpoints:**
  - `GET /api/candidates`: Returns candidate summary directory with job counts, ready/expired totals, and resume statuses.
  - `GET /api/candidates/:id`: Returns candidate profile details and assigned job queue list.
  - `GET /api/candidates/:id/jobs/:jobUrl`: Returns resolved job application with tagged form fields.
  - `GET /api/stats`: Returns pipeline metrics (candidates, scanned jobs, total fields, `supabase` vs `ai` percentages).
  - `GET /api/resumes/:id`: Serves candidate master PDF resume binary.
  - `GET /api/artifacts/:file`: Serves intermediate JSON/CSV artifacts.
  - `POST /api/pipeline/run`: Triggers full or partial pipeline execution asynchronously.
  - `GET /`: Serves the embedded single-page operator dashboard.

### 6.16 `src/orchestrator/pipeline.ts` & `src/orchestrator/runPipeline.ts`
- **Role:** Master coordinator executing all five automation steps sequentially with comprehensive timing metrics and error handling (`npm run pipeline`).
- **Key Functions / Classes:**
  - `V1Pipeline`: Orchestrates CSV deduplication, Playwright scanning, candidate segregation, profile syncing, and answer resolution.
  - `runFullPipeline(inputCsvPath?: string, outputDir?: string, options?: PipelineOptions): Promise<PipelineResult>`: Executes end-to-end workflow.

### 6.17 `dashboard/` UI Components
- **`App.tsx`:** Coordinates application state, candidate selection, job tab switching, and data polling.
- **`CandidateList.tsx`:** Left pane listing segregated candidates with search, filter tabs (All, Ready, Pending), job count chips, and resume indicators.
- **`JobQueueView.tsx`:** Right pane top tab bar showing job assignments for the selected candidate with status badges.
- **`FormRenderer.tsx`:** Right pane dynamic form renderer presenting pre-filled answers with green `supabase` and purple `ai` badges, confidence ratings, and readonly input controls.
- **`public/index.html`:** Standalone dashboard bundle containing React 18 CDN, Tailwind CSS, Heroicons, and embedded scripts for immediate browser execution.

### 6.18 `tests/e2e.test.ts`
- **Role:** Automated verification suite running 6 verification checkpoints:
  1. Pipeline Orchestrator execution.
  2. Scanned job template JSON and flattened CSV schema validation.
  3. Candidate segments JSON and PDF resume file existence.
  4. Multi-tier answer tagging strictness (`source: 'supabase'` vs `source: 'ai'`).
  5. Express REST API endpoint functionality and response schemas.
  6. Overall pipeline health and exit code assertion (`npm test`).

---

## 7. Intermediate File Schemas

### 7.1 Input CSV Schema (`greenhouse_only_applywizz_prod(in).csv`)
| Column | Type | Description | Sample Value |
| :--- | :--- | :--- | :--- |
| `Date` | `string` | Ingestion batch date | `2/9/2026` |
| `Applywizz ID` | `string` | Unique candidate identifier | `CAND-1001` |
| `Client Name` | `string` | Full candidate name | `Candidate Name` |
| `url` | `string` | Greenhouse job posting URL | `https://job-boards.greenhouse.io/example/jobs/12345` |
| `score` | `number` | Candidate job match score | `0` |
| `scored_jobId` | `string` | Internal job reference ID | `1001_4001` |
| `status` | `string` | Application state in batch | `PENDING` |

### 7.2 Scanned Job Form Templates (`output/scanned_jobs.json`)
```typescript
interface ScannedField {
  fieldId: string;
  name: string;
  type: 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'file' | 'location_autocomplete';
  label: string;
  isRequired: boolean;
  options?: string[];
  metadata?: {
    selector?: string;
    section?: string;
  };
}

interface ScannedJobTemplate {
  jobUrl: string;
  companyName: string;
  jobTitle: string;
  fields: ScannedField[];
  scannedAt: string;
  isExpired: boolean;
}
```

### 7.3 Flattened Scanned Fields CSV (`output/scanned_jobs.csv`)
| Header | Description |
| :--- | :--- |
| `jobUrl` | Canonical Greenhouse job posting URL |
| `companyName` | Extracted hiring company name |
| `jobTitle` | Extracted job position title |
| `scannedAt` | ISO timestamp of DOM scan |
| `isExpired` | Boolean string (`true` or `false`) |
| `fieldId` | Normalized field identifier |
| `fieldName` | HTML name attribute |
| `fieldType` | Form control type |
| `label` | Sanitized question label |
| `isRequired` | Boolean string (`true` or `false`) |
| `options` | Pipe-delimited list of dropdown/radio options (`Option 1 \| Option 2`) |
| `section` | Grouping section heading |
| `selector` | CSS selector used to locate element |

### 7.4 Candidate Segments (`output/candidate_segments.json`)
```typescript
interface CandidateSegment {
  applywizzId: string;
  clientName: string;
  profile?: ApplyWizzCandidateProfile;
  jobs: CandidateJobRecord[];
  totalJobs: number;
  syncedAt: string;
}
```

### 7.5 Resolved Job Applications (`output/resolved_applications.json`)
```typescript
interface ResolvedField {
  fieldId: string;
  name: string;
  type: string;
  label: string;
  value: string;
  source: 'supabase' | 'ai'; // Strict V1 source tagging
  confidence: number;
}

interface CandidateJobApplication {
  applywizzId: string;
  candidateName: string;
  jobUrl: string;
  companyName: string;
  jobTitle: string;
  status: 'READY_FOR_REVIEW' | 'EXPIRED' | 'PENDING';
  resolvedFields: ResolvedField[];
}
```

### 7.6 Persistent Candidate Q&A Store (`cache/qa_bank/${applywizzId}_qa.json`)
```typescript
interface CandidateQARecord {
  questionLabel: string;
  fieldId: string;
  fieldType: string;
  value: string;
  source: 'supabase' | 'ai';
  confidence: number;
  savedAt: string;
}
```

---

## 8. Identified Issues & Observations

| Severity | Issue / Observation | Context | Mitigation / Note |
| :--- | :--- | :--- | :--- |
| **Medium** | Modern Remix-based Greenhouse job boards hydrate dynamically without classic `#application_form` wrappers | Modern Greenhouse job postings (`job-boards.greenhouse.io`) render forms client-side with React Remix. | `PlaywrightScanner` implements dual inspection: extracts `window.__remixContext` state if present, and falls back to deep DOM traversal with wait states. |
| **Medium** | Rate limits on `grnh.se` shortlink HEAD requests when processing high volume | Processing thousands of shortlinks rapidly can trigger temporary 429 responses. | Implemented `resolveShortlinksBatch` with configurable concurrency (default 25), GET fallback, and persistent `shortlinkCache` map. |
| **Low** | Missing external LLM API key during offline/local testing | Local environment may not have `OPENROUTER_API_KEY` or `GEMINI_API_KEY` set. | `LLMSynthesizer` includes a deterministic fallback synthesizer to generate valid contextual answers and option alignment without throwing runtime errors. |
| **Observation** | 404/Closed job postings present in input CSV | Older job URLs in the CSV point to filled or expired job posts. | `playwrightScanner` detects closed notices and marks `isExpired: true`; `answerResolver` tags them as `status: 'EXPIRED'` without breaking the batch. |
| **Observation** | Isolation across candidate datasets | Multi-tenant processing of hundreds of candidates in bulk could risk profile contamination. | Strict isolation enforced: candidate functions are keyed exclusively by `applywizzId`, resumes are saved as `./resumes/${applywizzId}_resume.pdf`, and Q&A caches are segregated per candidate. |

---

## 9. Dependency Inventory

| Package | Version | Role / Category | Actual Usage in Codebase |
| :--- | :--- | :--- | :--- |
| `playwright` | `^1.50.1` | Browser Automation | Headless Chromium pool for DOM scraping and iframe extraction in `src/scanner/playwrightScanner.ts`. |
| `fast-csv` | `^5.0.3` | Data Processing | Stream-parsing input CSV and writing `scanned_jobs.csv`. |
| `csv-parser` | `^3.2.0` | Data Processing | Alternative stream CSV parser utility for large files. |
| `axios` | `^1.7.9` | HTTP Client | Communicates with ApplyWizz API and downloads master PDF resumes in `src/candidate/applywizzClient.ts`. |
| `fuse.js` | `^7.1.0` | Matching Engine | Fuzzy matching candidate attributes to form labels in `src/resolver/profileMatcher.ts`. |
| `@google/generative-ai` | `^0.24.0` | LLM Integration | Google Gemini SDK for synthesizing answers in `src/resolver/llmSynthesizer.ts`. |
| `openai` | `^4.86.1` | LLM Integration | OpenAI SDK for synthesizing answers in `src/resolver/llmSynthesizer.ts`. |
| `express` | `^4.21.2` | Web Framework | REST API server serving candidate queues and dashboard in `src/server/index.ts`. |
| `cors` | `^2.8.5` | Middleware | Cross-origin resource sharing middleware for Express. |
| `dotenv` | `^16.4.7` | Configuration | Loads environment variables from `.env` file into `process.env`. |
| `zod` | `^3.24.2` | Validation | Validates environment variables and runtime schema constraints. |
| `react` | `^19.2.8` | UI Library | Operator dashboard split-screen components in `dashboard/`. |
| `react-dom` | `^19.2.8` | UI Library | React DOM rendering for dashboard. |
| `typescript` | `^5.7.3` | Compiler | Type-checking and compilation with strict mode enabled. |
| `tsx` | `^4.19.3` | Dev Runner | Executes TypeScript scripts directly without manual compilation steps. |
| `ts-node` | `^10.9.2` | Dev Runner | TypeScript execution engine for test scripts. |

---

## 10. What's Not Yet Built

### Completed V1 Phases (Phases V1-1 through V1-6):
- [x] **Phase V1-1:** Node.js/TypeScript strict environment, types contracts (`src/types/index.ts`), and Zod environment validator (`src/config/env.ts`).
- [x] **Phase V1-2:** Branch 1 CSV deduplicator (`src/scanner/csvDeduplicator.ts`), Playwright headless worker pool (`src/scanner/playwrightScanner.ts`), and exporter (`src/scanner/exportScannedJobs.ts`).
- [x] **Phase V1-3:** Branch 2 ApplyWizz API client (`src/candidate/applywizzClient.ts`), candidate segregator (`src/candidate/segregator.ts`), and resume downloader (`./resumes/`).
- [x] **Phase V1-4:** Answer resolution engine (`src/resolver/profileMatcher.ts` for `'supabase'`, `src/resolver/llmSynthesizer.ts` for `'ai'`, and persistent candidate Q&A bank in `./cache/qa_bank/`).
- [x] **Phase V1-5:** Presentation REST API (`src/server/index.ts`) and Split-Screen Operator Dashboard (`dashboard/`).
- [x] **Phase V1-6:** Master End-to-End Pipeline Orchestrator (`src/orchestrator/pipeline.ts`) and Automated Verification Test Suite (`tests/e2e.test.ts`).

### Deferred V2+ Features (Explicitly Out of V1 Scope):
- [ ] **Automated Form Submission Engine:** Playwright auto-fill and submission execution on Greenhouse ATS boards.
- [ ] **Interactive Inline Manual Edits:** Dashboard inline editing of answers with `'manual'` source tagging and automatic persistence to Candidate Q&A Bank.
- [ ] **Dual Proof Verification Capture:** Automated screenshot capture of Greenhouse post-submission confirmation screen + Zoho Mail confirmation email screenshot via `zohomailconnector`.
- [ ] **Automated CAPTCHA Solver:** Integration with CapSolver / 2Captcha for Cloudflare Turnstile / reCAPTCHA challenges.
- [ ] **Supabase PostgreSQL Cloud Migration:** Database DDL schema migration, RLS policies, and Supabase Storage buckets (`resumes`, `proofs_web`, `proofs_email`).
- [ ] **Residential Proxy Rotation & Cloud Worker Daemon:** Residential proxy pool routing and PostgreSQL queue daemon (`FOR UPDATE SKIP LOCKED`).
