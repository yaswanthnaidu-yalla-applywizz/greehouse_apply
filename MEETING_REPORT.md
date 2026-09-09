# Greenhouse Apply — Meeting Notes

**Status:** Phase V2 complete | **Dashboard:** `localhost:3001`

---

## What It Is
- Automates Greenhouse job applications end-to-end
- CSV → profile sync → form scan → auto-fill answers → operator review → live submit

## How It Works
- **Scan** — Playwright extracts form fields from job URLs
- **Resolve** — 3-tier offline waterfall fills answers:
  - Tier 1: Profile + QA bank memory
  - Tier 2: Resume PDF parse
  - Tier 5: Local LLM (Ollama llama3.1)
- **Submit** — Playwright fills & submits; operator handles OTP/CAPTCHA via dashboard

## Key Features
- Operator dashboard for review, edit, dry-run, and submit
- OTP/CAPTCHA pause-resume (alphanumeric codes up to 16 chars)
- Screenshot proofs at every stage (open, submit, fail, success)
- QA bank — answers remembered for repeat questions
- Company email only (`@applywizz.*`) — never personal email
- Cover letters never filled (policy)

## Recent Wins
- Company email enforced + 309 profiles backfilled
- Yes/No questions strictly binary
- India/+91 phone handling for demo profile
- Post-submit CAPTCHA detection + headful browser fallback
- 100% offline resolution (no API calls during answer generation)

## Demo
- Candidate: **AWL-YASWANTH** (Yaswanth Naidu Yalla)
- Run: `npm run dashboard` → `http://localhost:3001`

## Known Gaps
- OTP sessions lost on server restart (in-memory only)
- Dashboard UI requires manual `index.html` mirroring

## Next Up
- Persist paused sessions across restarts
- Auto-build dashboard from `.tsx` files
- Parallelize resolution for scale

## Stack
- Node/TypeScript, Playwright, Supabase, Express, Ollama (local LLM)
