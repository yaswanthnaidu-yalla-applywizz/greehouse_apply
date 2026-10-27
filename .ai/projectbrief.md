# Project Brief — ApplyWizz ATS Automation

## What This Is
Internal bulk job-application automation platform. Operators upload CSV candidate-to-job mappings; the system scans job forms, resolves candidate answers, and submits applications with operator review at the approval gate.

## Target Users
- **Operators** — review, approve, and submit applications through the dashboard.
- **Managers / COO** — review team-scoped client activity at `/manager`.
- **Admins** — manage organization operations and CSV ingestion at `/admin`.
- **Developers** — use technical operations tools at `/dev`.

## Current ATS Status
- **Greenhouse** — supported production workflow for `boards.greenhouse.io`, `job-boards.greenhouse.io`, `app.greenhouse.io`, custom subdomains, and `grnh.se` shortlinks.
- **Ashby** — scanner and submission code are implementation-ready; residential proxy configuration and a live end-to-end submission smoke test remain blockers. Do not describe Ashby as live or production-ready until verified.
- **ATS expansion candidates** — research and context maintenance only. No implementation is approved. Work proceeds sequentially, with Lever the only next candidate. Each platform requires its own completed plan before implementation.

Research order: **Lever, SmartRecruiters, ApplyToJob, JazzHR, Rippling, Workable, BambooHR**. Present scope is research for Lever single-page automation. Eligibility rules for multi-step forms, account/SSO, SMS, CAPTCHA, redirects, and ambiguous domains are undecided and must be set in each platform plan.

## Hard Constraints
- ATS submission uses **Playwright only**. API-based scanning is allowed; API-based submission is not.
- Preserve resolver safeguards, cached resume behavior, SHA-256 question fingerprinting, idempotent upserts, and headful/headless compatibility.
- `MAX_JOB_QUESTIONS` is explicitly capped at **35**; jobs with `field_count >= 35` are skipped. Do not raise the cap without explicit instruction.
- Candidate identity source: ApplyWizz API (`https://www.apply-wizz.me/api/get-client-details?applywizz_id=AWL-****`).
- Deployment: Railway (single service, Docker).

## Explicit Out of Scope
- CAPTCHA bypass services or automated challenge solving.
- ATS expansion implementation before a platform-specific plan is approved and completed.
- Multi-tenant Supabase RLS on core tables (app-level role dashboards are shipped; event tables use service-role-only RLS).
- Raising the 35-question cap without explicit instruction.

## Input / Output
| Input | Output |
|---|---|
| CSV: `applywizz_id, job_url` pairs | `candidate_applications` rows after resolution (or `SKIPPED` for over-cap jobs) |
| ApplyWizz API candidate profile and resume PDF | Web proof screenshots in the `proofs_web` Supabase bucket |
| Supported ATS pages | Application status, evidence, and confirmation workflow |
