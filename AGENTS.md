# 🤖 AI Agent Operational Rules & Codebase Guidelines

## 🚨 CRITICAL RULES

### 1. ApplyWizz API Strict Restriction & Permission
1. **NEVER CALL THE APPLYWIZZ API WITHOUT EXPLICIT USER PERMISSION.**
   - Endpoint: `https://www.apply-wizz.me/api/get-client-details?applywizz_id=<AWL_ID>`
   - Every single time there is a need or intent to call the ApplyWizz API, you **MUST** inform the user first and obtain explicit permission before executing the request.
2. **Prioritize Local Cache & Supabase**:
   - Always check local cache (`cache/profiles/{applywizzId}.json`) and Supabase table `profiles` before doing anything else.
   - Do not bypass cache, do not pass `forceRefresh: true`, and do not run batch sync commands that trigger unapproved outbound API requests.
3. **No Unapproved External API Polling**:
   - Do not run loops or repetitive test queries hitting external endpoints.

### 2. NO SYNTHETIC TESTS & MAXIMUM TOKEN EFFICIENCY
1. **DO NOT WRITE SYNTHETIC/MOCK TESTS**:
   - Never write throwaway mock test suites, synthetic HTML fixtures, or run artificial test loops to simulate flows.
   - Stop wasting time and tokens creating mock tests.
2. **Utmost Token Efficiency**:
   - Write direct, minimal, production-grade code changes only.
   - Keep chat responses extremely concise, direct, and token-efficient (no verbose explanations, filler, or speculative artifacts).
   - Real-world validation is done directly on real flows only when explicitly requested by the user.

---

## 📋 PENDING TASKS

See `CODEBASE_ANALYSIS.md` for full context:

### P1 — Reliability
1. **Persist paused sessions across restart** — `PAUSED_SESSIONS` in `liveSubmit.ts` is in-memory only.
   - Files: `src/submitter/liveSubmit.ts`, `src/submitter/captchaResume.ts`, `src/server/routes/submissions.ts`
2. **Dashboard build pipeline** — Eliminate manual `index.html` mirroring from `dashboard/*.tsx`.
3. **Unify `ApplicationStatus` types** — Canonical type is `src/db/applications.ts`; `src/types/index.ts` is stale.

---

## ✅ COMPLETED TASKS (do not re-implement)

### Alphanumeric OTP Modal & Multi-Box Resolution
- **Goal**: Support alphanumeric verification codes (e.g. `Aebf0aDc`) up to 16 characters in dashboard and Playwright submitter; auto-submit on CAPTCHA resolution.
- **Status**: ✅ Done
- **Implementation**:
  - `dashboard/components/SubmissionControls.tsx` & `dashboard/public/index.html`: updated OTP input from numeric-only `\D` filter with `maxLength={6}` to alphanumeric regex `/[^a-zA-Z0-9]/g` with `maxLength={16}` and placeholder `Enter OTP code (e.g. Aebf0aDc)`.
  - `src/submitter/liveSubmit.ts`: `pollCaptchaSolved` passes `jobUrl` to `storePausedSession`; `submitOtpToPausedSession` falls back to `session.jobUrl` and fills multi-box alphanumeric characters sequentially.

### Company Email Priority
- **Goal**: Candidate email must always be the **Company Email** (`client.company_email`), NOT personal email.
- **Status**: ✅ Done
- **Implementation**:
  - `src/candidate/applywizzClient.ts` — `company_email` prioritized over `personal_email` at ingestion
  - `src/db/profiles.ts` — `getCompanyEmail()` centralizes lookup (column → `raw_api_payload` → fallback)
  - `src/resolver/tier1Supabase.ts` — email fields resolved via `getCompanyEmail(profile)`
  - `src/db/migrations/001_add_company_email.sql` + `src/db/backfillCompanyEmail.ts`

### Yes/No Question Enforcement
- **Goal**: Binary/relocation questions must return strictly `"Yes"` or `"No"` — never location strings or prose.
- **Status**: ✅ Done
- **Implementation**:
  - `src/resolver/tier1Supabase.ts` — relocation/same-city check runs **before** location string match; uses `matchBestOption('Yes'|'No', field.options)`
  - `src/resolver/llmSynthesizer.ts` — `isBinaryYesNoQuestion()`, strict prompt injection, `coerceBinaryYesNo()` post-processing

### AWL-YASWANTH Demo Profile Country & Phone Code
- **Goal**: Candidate `AWL-YASWANTH` must always have `country: 'India'` and `country_code: '+91'`. Tier 1 resolution for `country` and `phone_country` must return `"India"`.
- **Status**: ✅ Done
- **Implementation**:
  - `src/candidate/applywizzClient.ts` — hardcoded country and countryCode for `AWL-YASWANTH` in API parsing and local cache retrieval.
  - `src/db/profiles.ts` — added `country` and `country_code` to `ProfileRow` and `profileRowToCandidateProfile`; guaranteed fallback profile and upsert payload for `AWL-YASWANTH`.
  - `src/resolver/tier1Supabase.ts` — deterministic Tier 1 resolution maps `phone_country`, `country_code`, and `country` to `"India"` / `"+91"` for `AWL-YASWANTH`.
  - `src/dashboard/demoFixtures.ts` & `cache/profiles/AWL-YASWANTH.json` — demo fixtures and offline cache configured with India and +91.

---

## 🛠️ General Rules
- Local LLM is configured with Ollama Llama 3.1 (`llama3.1:latest` via `http://127.0.0.1:11434/v1`).
- Never fill or upload cover letters.
- Strip leading `+1` from phone numbers.
- TypeScript build must always compile with 0 errors (`npm run build`).
- Do not create plan artifacts in .md files; output direct answers to avoid token wastage.
- Capture a full-page screenshot before closing any Playwright browser, regardless of application status.
- Planning reference: `CODEBASE_ANALYSIS.md` — use for scoping, file locations, constraints, and backlog.
