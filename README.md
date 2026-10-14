# greehouse_apply

[![CI](https://github.com/yaswanthnaidu-yalla-applywizz/greehouse_apply/actions/workflows/ci.yml/badge.svg)](https://github.com/yaswanthnaidu-yalla-applywizz/greehouse_apply/actions/workflows/ci.yml)

Internal ApplyWizz Greenhouse application automation (V2+). Operators ingest CSV candidate→job mappings; Playwright scans forms, a 5-tier resolver fills answers, and a role-based dashboard reviews and submits.

**Read [`OVERVIEW.md`](./OVERVIEW.md)** for architecture, product flows, critique, and planning questions.

Production: https://gh.applywizz.ai · `npm run dashboard` locally · see `.ai/techContext.md` for env and commands.

### Key Capabilities
- **Playwright-Based Job Scanning:** Accurate DOM extraction of single-page and multi-step Greenhouse applications.
- **5-Tier Waterfall Resolver:** Answers questions using Supabase candidates data, parsed resumes, Q&A memory banks, corporate policies, and LLM reasoning.
- **Dynamic Cascade & Searchable Dropdowns:** Handles cascading form fields (e.g. conditional demographic disclosures) and React-Select autocomplete interfaces.
- **Automated Zoho & Gmail OTP Handling:** Resolves email verification challenges via high-speed REST endpoints.
