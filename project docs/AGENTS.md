# AGENTS.md — Greenhouse Job Application Automation

## Code Generation Tool
**Antigravity CLI (`agy`) is the sole code generation tool for this project.** Use Plan mode first, Agent mode only after reviewing the plan diff. Fresh `agy` chat at the start of every phase.

## Workflow Rules
- **Smallest diff that satisfies the current phase checkpoint** — no speculative scope, no future-proofing.
- **Test before marking any phase done:** self-run the checkpoint from `06-implementation.md` for the current phase. Do not mark done until checkpoint passes.
- **No silent dependencies** — flag any new npm package before adding it; nothing paid beyond what's already approved (Gemini SDK or OpenAI SDK free tier).
- **Ask if ambiguous** — do not guess at Greenhouse DOM selectors, field name patterns, or ApplyWizz API response shapes. Check `03-workflow.md` / `05-backend-schema.md` first; ask if still unclear.
- **Update docs (README / JSDoc) as part of finishing each slice**, before moving to the next phase.
- **No V2+ code in V1 phases.** Submission engine, CAPTCHA, Zoho Mail proof capture, and `manual` tag are strictly V2+. Flag and defer if scope creep appears.

## State & Codebase Tracking (Required at Every Commit)

### STATE.md
Update `STATE.md` at every commit. Required fields:
```
## Current Phase
<Phase ID and name — e.g. "V1-3: Branch 2 — ApplyWizz API Sync">

## Phase Status
<NOT STARTED | IN PROGRESS | CHECKPOINT PASSED>

## What's Done
<Bulleted list of completed phases with one-line summaries>

## What's In Progress
<Current phase description and any blockers>

## What's Next
<Next phase ID and name>

## Latest Commit
<Commit hash> — <Commit message>
<Date> | <Branch name>
<Brief description of what changed>
```

### CODEBASE_ANALYSIS.md
Update `CODEBASE_ANALYSIS.md` at every commit. This file is the living technical map of the repo. Required sections (follow the structure in the reference `codebase-analysis.md`):
1. **Executive Summary** — what the system does, how it works in 3–5 sentences
2. **Repository Structure** — directory tree with file-level annotations and line count estimates
3. **Tech Stack** — table: Layer | Technology | Purpose
4. **Environment Variables** — table: Variable | Required | Description
5. **Data Flow Summary** — ASCII or Mermaid flow showing how data moves through the pipeline
6. **Module Deep Dives** — per-file breakdown of key functions, their inputs/outputs, and how they connect
7. **Intermediate File Schemas** — current shape of `output/scanned_jobs.csv`, `output/scanned_jobs.json`, and candidate resolution output
8. **Identified Issues & Observations** — Critical / Medium / Observations table (add new entries as discovered, never delete old ones without a note)
9. **Dependency Inventory** — table: Package | Version | Role
10. **What's Not Yet Built** — honest list of stubs, unimplemented functions, and deferred V2+ features still referenced in code

**Update rule:** after every `git commit`, re-run an `agy` prompt to regenerate the affected sections based on the current diff. Do not leave `CODEBASE_ANALYSIS.md` describing old code after a commit.

## Project-Specific Rules
- All Playwright scanning code lives in `src/scanner/`. No Playwright imports in `src/resolver/`, `src/candidate/`, or `src/server/`.
- All candidate data operations live in `src/candidate/`. Every function that reads or writes candidate data must be scoped by `applywizzId` — no function may mix or share profile data, resume paths, or resolved answers across candidates. The system processes hundreds of candidates in bulk; isolation prevents cross-contamination between rows.
- The `source` tag on every `ResolvedField` must be `"supabase"` or `"ai"` — no other value is valid in V1. Unresolved fields are tagged `"unresolved"` and surfaced as warnings, never silently dropped.
- `scanned_jobs.json` is the source of truth for Branch 2. Branch 2 never re-scans a URL; it always reads from the Branch 1 output file.
- Resume files are saved as `./resumes/${applywizzId}_resume.pdf`. Never overwrite a resume with another candidate's file.
- LLM prompts must include: candidate profile summary + resume text excerpt + job title/company + exact question label + available options (for select/radio). Never prompt without candidate context.
- Expired / 404 job links are marked `isExpired: true` in `scanned_jobs.json` and surfaced as `EXPIRED` status in the dashboard. Never silently skip them.
- The scanner pool (3–5 workers) must apply a 3–6 second randomized jitter between consecutive page loads. No rapid-fire scanning without delay.
- TypeScript strict mode is enabled. Zero `any` types in `src/types/index.ts`. Use `unknown` + type guards where input shapes are uncertain.
- No hardcoded ApplyWizz API keys or LLM API keys in source. All secrets via `.env` + `src/config/env.ts`.

## .cursor/rules/ — Not Applicable
This project uses Antigravity CLI only. No `.cursor/rules/` files needed.

## Document Index
The eight docs (`01`–`06`) + `MASTER_GOAL.md` + `requirement_interview_for_context_persistence.md` are the fixed spec. If implementation reveals the docs are wrong or incomplete, stop and flag it — do not silently deviate.

| File | Purpose |
| :--- | :--- |
| `01-prd.md` | Product requirements, features, success metrics |
| `02-trd.md` | Architecture, tech stack, component specs, interface contracts |
| `03-workflow.md` | Two-branch workflow, sequence diagrams, edge cases |
| `04-ui-ux.md` | Split-screen dashboard layout and component breakdown |
| `05-backend-schema.md` | All data schemas (input CSV, scanned fields, resolved fields, V2+ Supabase DDL) |
| `06-implementation.md` | Phased build plan, per-phase checkpoints, verification commands |
| `MASTER_GOAL.md` | Full-scope vision including V2+ and V3 roadmap |
| `requirement_interview_for_context_persistence.md` | Authoritative context log and requirement transcript |
