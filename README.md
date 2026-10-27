# Greenhouse Application Automation System

[![CI](https://github.com/yaswanthnaidu-yalla-applywizz/greehouse_apply/actions/workflows/ci.yml/badge.svg)](https://github.com/yaswanthnaidu-yalla-applywizz/greehouse_apply/actions/workflows/ci.yml)

An enterprise automation engine for Greenhouse and single-page Applicant Tracking Systems (ATS). The platform scans job application forms, resolves candidate answers through a five-tier waterfall resolver, enforces human review gates, and submits applications using Playwright browser automation.

---

## Part 1: Executive and Business Overview

### The Problem

Manual ATS application submission creates an operational bottleneck for hiring and staffing teams:

- **Labor intensive repetitive work.** Operators spend 10 to 15 minutes per application copying personal data, attaching resumes, and retyping answers for standard compliance, demographic, and work authorization questions.
- **High error rates.** Fatigue leads to typos, missed mandatory fields, and inconsistent answers across different postings.
- **Inconsistent records.** Manual submissions lack standardized tracking, centralized answer retention, and visual verification records.
- **Linear scaling cost.** Scaling application volume manually requires adding headcount proportionally, which drives operational costs up while quality degrades.

### Business Value and Operational Impact

- **Operational scale.** Automated DOM scanning and answer resolution reduce the time required to prepare an application from minutes to seconds.
- **Deterministic accuracy.** Answers pull from verified candidate records and historical answer banks. Candidate data remains consistent across all submissions.
- **Cost reduction.** The platform automates repetitive data entry, which lets operators focus on quality control and candidate strategy.
- **Complete auditability.** Every submission generates a timestamped event log and a full-page screenshot proof of completion.

### Risk Controls and Safety Architecture

The system enforces safety boundaries to protect candidate reputation and data integrity:

- **Deterministic-first resolution.** The resolution engine prioritizes canonical profiles, parsed resume data, and verified historical answers before querying an LLM. An LLM never overrides verified candidate facts.
- **Human-in-the-loop review gate.** Automated resolution prepares applications in a pending state. Operators inspect, edit, and approve every form field on the dashboard before the submission worker fires.
- **Question complexity ceiling.** The system automatically skips job postings with 35 or more fields. This ceiling prevents the engine from entering malformed forms, infinite loops, or unverified multi-page questionnaires.
- **Zero challenge bypass.** The platform does not use third-party CAPTCHA-cracking services. When an ATS presents an automated bot challenge, the system halts execution for manual inspection.

### Verification and Audit Trail

- **Visual proof archival.** The submission engine captures full-page post-submission screenshots and stores them in encrypted object storage.
- **Automated confirmation verification.** Background workers poll email connectors for verification emails and one-time passcodes (OTP) to confirm that the ATS accepted the application.
- **Tamper-proof event logging.** Every lifecycle event (ingest, scan, resolve, edit, approve, submit, and verify) is recorded with timestamps in PostgreSQL.

### End-to-End Application Workflow

```
[Job URL & Candidate Record]
           │
           ▼
   1. DOM Extraction
   Playwright extracts fields, options, and constraints from the ATS.
           │
           ▼
   2. 5-Tier Resolution
   Engine resolves fields using candidate profile, resume, and answer banks.
           │
           ▼
   3. Review Gate
   Operators inspect, edit, and approve answers in the dashboard.
           │
           ▼
   4. Playwright Submission
   Worker opens browser, fills inputs, handles custom selects, and submits.
           │
           ▼
   5. Verification & Proof
   System captures screenshot proof, verifies OTP or confirmation email, and logs state.
```

---

## Part 2: Engineering and Technical Architecture

### System Architecture

The platform runs as a Node.js and TypeScript application backed by PostgreSQL and Playwright workers.

```
┌─────────────────────────────────────────────────────────────┐
│                       Web Dashboard                         │
│       React 19 + TypeScript + Tailwind CSS (Vite bundle)    │
└──────────────┬──────────────────────────────▲───────────────┘
               │                              │
               ▼                              │
┌─────────────────────────────────────────────────────────────┐
│                     Express API Server                      │
│            REST Endpoints & WebSocket Event Stream          │
└──────────────┬──────────────────────────────▲───────────────┘
               │                              │
               ▼                              │
┌─────────────────────────────────────────────────────────────┐
│                    PostgreSQL (Supabase)                    │
│      Applications, Jobs, Questions, Candidates, Events      │
└──────────────┬──────────────────────────────▲───────────────┘
               │                              │
       ┌───────┴──────────────┐        ┌──────┴──────────────┐
       ▼                      ▼        ▼                     ▼
┌──────────────┐      ┌──────────────┐   ┌─────────────────────────┐
│  DOM Scanner │      │   Resolver   │   │    Submission Worker    │
│  Playwright  │      │ 5-Tier Engine│   │ Playwright + Stealth    │
└──────────────┘      └──────────────┘   └────────────┬────────────┘
                                                      │
                                                      ▼
                                         ┌─────────────────────────┐
                                         │  Greenhouse ATS Portal  │
                                         └─────────────────────────┘
```

### Core Subsystems

#### 1. DOM Scanner (`src/scanner/`)

The scanner navigates to Greenhouse job postings to extract form structure:

- Supports `boards.greenhouse.io`, `job-boards.greenhouse.io`, `app.greenhouse.io`, custom company subdomains, and `grnh.se` shortlinks.
- Detects standard inputs: text, email, phone number, textareas, native selects, radio button groups, checkboxes, and file upload fields.
- Handles custom React-Select autocomplete controls.
- Generates a deterministic question fingerprint using a SHA-256 hash of the question label and type: `SHA-256(label + "|" + type)[0:16]`.
- Implements random timing jitter between requests to respect target rate limits.
- Enforces the `MAX_JOB_QUESTIONS=35` limit. If the total field count is 35 or higher, the job is marked `SKIPPED`.

#### 2. Five-Tier Waterfall Resolver (`src/resolver/`)

Every detected form field passes through a sequential five-tier resolution waterfall. Processing stops at the first tier that returns a valid value.

1. **Tier 1: Canonical Candidate Profile.** Direct lookup for primary candidate attributes: first name, last name, email address, phone number, location, LinkedIn URL, GitHub URL, and portfolio website.
2. **Tier 2: Parsed Resume Cache.** Structured data extracted from the candidate's resume (work history, educational degrees, technical skills, and certifications). Resumes are parsed once and cached in the database.
3. **Tier 3: Historical Q&A Memory.** Semantic vector search and fingerprint matching against previously answered questions from verified candidate records.
4. **Tier 4: Policy and Compliance Defaults.** Deterministic company policy defaults for EEO demographic disclosures, non-compete declarations, veteran status, and disability questionnaires.
5. **Tier 5: LLM Reasoning.** Fallback reasoning provider (OpenRouter, Amazon Bedrock, or OpenAI) scoped strictly to the candidate's parsed resume and the question's option list. Pure hallucinations are prevented by validating LLM outputs against allowed form choices.

#### 3. Submission Engine (`src/submitter/`)

The submission engine executes the application in a Playwright browser instance:

- **Headless and headful parity.** Runs headful for local debugging and headless in containerized production environments.
- **React-Select interactions.** Clicks the custom select container, types search text, waits for the dropdown menu in the DOM, and clicks the matching option element.
- **Cascading dependencies.** Monitors dynamic inputs that appear only after selecting a specific parent option (such as visa sponsorship detail fields).
- **File attachments.** Uploads the candidate resume file to the target ATS file input.
- **Automated OTP handling.** Connects to email verification REST services to poll for one-time passcodes and completes email challenge screens automatically.
- **Proof capture.** Takes a full-page screenshot of the final confirmation screen and uploads the image to object storage.

#### 4. Role-Based Dashboard (`dashboard/`)

A single-page React application built with TypeScript and Tailwind CSS:

- **Operator interface.** Review applications in pending state, edit individual field answers, approve applications, and trigger live submissions.
- **Manager interface.** Team-scoped overview of operator productivity, daily submission metrics, and queue depth.
- **Admin interface.** Batch job ingestion, system configuration, and user account management.
- **Developer interface.** Real-time job scanning, manual resolution testing, and submission logs.

### Tech Stack

- **Runtime and Language:** Node.js 22+, TypeScript 5.7.
- **Browser Automation:** Playwright 1.50 with `puppeteer-extra-plugin-stealth`.
- **Database and Storage:** PostgreSQL, Supabase JS client, S3-compatible object storage.
- **Frontend:** React 19, Vite, Tailwind CSS.
- **Backend Server:** Express 4 with WebSocket support for live logs.
- **Deployment:** Docker container deployed on Railway.

### Developer Quickstart

#### Prerequisites

- Node.js version 22 or higher
- npm version 10 or higher
- Access to a PostgreSQL instance (or local Docker container)

#### Environment Setup

1. Copy the example environment file:

```bash
cp .env.example .env
```

2. Edit `.env` and fill in your database credentials, storage bucket names, and LLM provider keys. Keep all production credentials secure.

#### Installation

Install project dependencies:

```bash
npm install
```

Install Playwright browser binaries:

```bash
npx playwright install chromium
```

#### Database Migrations

Apply database schema migrations:

```bash
npm run db:migrate
```

#### Running the Local Dashboard

Start the application server:

```bash
npm run dashboard
```

Open `http://localhost:3001` in your browser.

#### Pipeline CLI Commands

Scan a Greenhouse job URL:

```bash
npm run scan -- --url="https://boards.greenhouse.io/example/jobs/12345"
```

Resolve form fields for a scanned job:

```bash
npm run resolve -- --jobId="<job-id>" --candidateId="<candidate-id>"
```

Execute a dry-run submission in headful mode (fills fields without submitting):

```bash
npm run dry-run -- --applicationId="<application-id>"
```

Execute live submission:

```bash
npm run submit -- --applicationId="<application-id>"
```

#### Running Verification and Tests

Run the unit test suite:

```bash
npm run test:unit
```

Run end-to-end integration tests:

```bash
npm test
```

Run TypeScript type checks:

```bash
npm run typecheck
```
