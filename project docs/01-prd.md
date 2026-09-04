# PRD — Greenhouse Job Application Automation V1

## 1. Problem Statement
Manual job applications for candidates across Greenhouse job boards are slow, repetitive, and resource-intensive. Greenhouse job postings feature a mix of standard fields and dynamic, custom behavioral questions. Operators need an automated, high-throughput system to ingest bulk candidate-job mappings from CSV, deduplicate and scan Greenhouse job application forms once per unique link, auto-resolve candidate answers using profile data or AI with clear source attribution (`supabase` vs `ai`), and view all segregated candidate queues and resolved answers in a centralized operator dashboard.

## 2. Target Users & Operating Model
- **Target ATS:** Greenhouse (`boards.greenhouse.io`, `job-boards.greenhouse.io`, `app.greenhouse.io/embed/...`, custom company subdomains, and `grnh.se/...` shortlinks).
- **Primary Users:** Internal operators managing bulk candidate job applications.
- **Operating Environment:** Local Node.js / Playwright worker and React Native / Web Operator Dashboard.

---

## 3. Goals & Non-Goals

### V1 Goals (Flowchart 2: Lines 25–57)
- **Bulk CSV Ingestion:** Parse `greenhouse_only_applywizz_prod(in).csv` containing `Date`, `Applywizz ID`, `Client Name`, `url`, `score`, `scored_jobId`, and `status`.
- **Branch 1 (Unique Link Deduplication & Scanning):**
  - Extract the distinct set of Greenhouse URLs across all CSV rows.
  - Launch Playwright to open each unique job URL once and deeply scan all form questions, input types, required flags, and dropdown options.
  - Output scanned questions into a structured intermediate CSV/JSON file.
- **Branch 2 (Candidate Segregation & Tagged Q&A Resolution):**
  - Segregate input records by `Applywizz ID` (AWL id).
  - Sync candidate details & download master resume from the ApplyWizz API (`https://www.apply-wizz.me/api/get-client-details?applywizz_id=AWL-****`).
  - Map each candidate's jobs to the scanned fields from Branch 1.
  - Multi-tier Answer Resolution:
    - Standard/stored profile fields $\rightarrow$ Tag: `supabase`
    - Custom/unmapped questions $\rightarrow$ Synthesize via LLM (Gemini/OpenAI) $\rightarrow$ Tag: `ai`
- **Operator Dashboard Viewer:**
  - Split-screen interface: Left pane lists segregated candidates with job counts; Right pane renders candidate job queues and scanned form questions with visual source badges (`supabase` / `ai`).

### Non-Goals for V1 (Deferred to V2+)
- Automated form submission & file upload execution (Lines 59–67 of Flowchart 2).
- Interactive manual editing loop & persistence back to Q&A bank.
- Multi-channel proof capture (Webpage screenshot + Zoho Mail confirmation email screenshot).
- CAPTCHA automated bypass (CapSolver / 2Captcha).
- Full Supabase Cloud Database & Storage migration (V1 uses local structured CSV/JSON cache for maximum development speed).

---

## 4. Core Features & Priority Matrix

| Feature ID | Feature Name | Description | Priority |
| :--- | :--- | :--- | :--- |
| **FEAT-01** | CSV Ingestion & Validation | Parse `greenhouse_only_applywizz_prod(in).csv` and validate schema. | **P0** |
| **FEAT-02** | URL Deduplication & Normalization | Extract distinct Greenhouse URLs; normalize redirects (`grnh.se`) and strip tracking params. | **P0** |
| **FEAT-03** | Playwright Unique Form Scanner | Open each unique link once; extract standard inputs, dynamic questions, selects, radios, checkboxes. | **P0** |
| **FEAT-04** | Structured Scanned CSV Export | Save scanned form metadata to an intermediate structured CSV (`scanned_jobs.csv`) / JSON. | **P0** |
| **FEAT-05** | Candidate Segregation | Group CSV rows by `Applywizz ID` and associate them with candidate profiles. | **P0** |
| **FEAT-06** | ApplyWizz API Sync | Query candidate personal details, visa status, education, work history, and download resume PDF. | **P0** |
| **FEAT-07** | Answer Resolution Engine | Populate form questions per candidate; tag with `supabase` (profile match) or `ai` (LLM synthesis). | **P0** |
| **FEAT-08** | Operator Dashboard Viewer | Split-screen React Native / Web UI to browse candidates, job queues, and inspect tagged Q&A. | **P0** |

---

## 5. Success Metrics
1. **Deduplication Efficiency:** $N$ duplicate job rows across candidates result in exactly $1$ Playwright page scan.
2. **Field Extraction Accuracy:** $>98\%$ of standard and dynamic Greenhouse form questions accurately detected with field type, label, and options.
3. **Source Tag Accuracy:** $100\%$ of profile-matched fields tagged as `supabase`, and $100\%$ of LLM-generated fields tagged as `ai`.
4. **Dashboard Load & Responsiveness:** Instant switching between candidates and real-time display of populated job forms.
