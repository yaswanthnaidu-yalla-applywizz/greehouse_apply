# Project Brief — ApplyWizz Greenhouse Automation

## What This Is
Internal bulk job-application automation platform. Operators upload a CSV of candidate→job-URL mappings; the system scans Greenhouse forms, resolves answers per candidate, and submits applications autonomously via Playwright. Operators review and approve via a split-screen dashboard.

## Target Users
- **Operators** — primary users; review/approve/submit applications via dashboard
- **Managers / COO** — client table at `/manager`; team scoped via `users.manager_email` → operator assignments; date filter, expandable proofs
- **Admins** — org ops at `/admin` including CSV ingest Start
- **Developers** — technical dashboard at `/dev`

## Core Problem Solved
Manually applying to hundreds of Greenhouse ATS postings per candidate is operationally unscalable. This system automates scanning form structure, resolving per-candidate answers, and submitting — with operator oversight at the review gate.

## Hard Constraints (Non-Negotiable)
- Target ATS: **Greenhouse only** (`boards.greenhouse.io`, `job-boards.greenhouse.io`, `app.greenhouse.io`, custom subdomains, `grnh.se` shortlinks)
- Submission method: **Playwright browser automation only** — no Greenhouse API
- Max questions per job: **< 35** (config: `MAX_JOB_QUESTIONS=35`) — jobs with ≥ 35 fields are skipped
- Candidate identity source: **ApplyWizz API** (`https://www.apply-wizz.me/api/get-client-details?applywizz_id=AWL-****`)
- Deployment: **Railway** (single service, Docker)

## Explicit Out of Scope (V3+)
- CAPTCHA automated bypass (CapSolver / 2Captcha) — currently operator-manual
- Multi-tenant Supabase RLS on core tables (app-level role dashboards shipped; 015 event tables use service_role-only RLS)
- Residential proxy pool
- Further lifting the question cap (raise `MAX_JOB_QUESTIONS` when ready)

## Input / Output
| Input | Output |
|---|---|
| CSV: `applywizz_id, job_url` pairs | `candidate_applications` rows after resolution (or SKIPPED over-cap) |
| ApplyWizz API (candidate profile JSON + resume PDF) | Web proof screenshots in `proofs_web` Supabase bucket |
| Greenhouse ATS pages (DOM via Playwright) | Status: `APPLIED` / `FAILED` / `CAPTCHA_REQUIRED` |
