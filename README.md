# 🌿 Greenhouse Automated Job Application System (V3 Cloud Edition)

A production-grade, cloud-native automated platform for high-throughput Greenhouse job applications. Features segregated operator queues, Microsoft Authenticator 2FA, 5-tier waterfall answer resolution, Playwright browser automation with alphanumeric OTP resolution, dual-channel proof capture (Web + Zoho Mail), and seamless cloud deployment on Railway.

---

## 🚀 What's New in V3

- **24/7 Cloud Operator Dashboard**: Fully responsive web dashboard served via Express, ready for continuous operation on Railway (`0.0.0.0:$PORT`).
- **CA Candidate Segregation & Work-History Integration**: Queries the ApplyWizz CA Management API for yesterday's assigned candidates based on fixed India Standard Time (Asia/Kolkata, UTC+5:30), with automatic 7-day fallback for weekends and days off.
- **Enterprise Security**: Microsoft Authenticator TOTP 2FA, passwordless verification, and JWT Bearer route authorization.
- **Alphanumeric OTP & Multi-Box Resolution**: Handles complex verification codes up to 16 characters (e.g. `Aebf0aDc`) across multi-box form inputs.
- **Strict Data Grounding**: Company email strictly prioritized (`client.company_email`), binary questions forced strictly to `"Yes"` or `"No"`, and zero cover letters.
- **Dual-Channel Proof Lifecycle**: Cryptographic full-page web submission screenshot capture + automatic Zoho Mail reader polling for confirmation emails.
- **Railway Cloud Ready**: Containerized with multi-stage `Dockerfile` (Node 20 + Playwright Chromium dependencies) and `railway.json` health checks.

---

## 🏗️ Architecture & Workflow

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              GREENHOUSE V3 ARCHITECTURE                                │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│  [Operator Auth & Segregation]                                                         │
│  Operator Login ➔ Microsoft Authenticator TOTP ➔ Work-History API (IST Yesterday)     │
│  ➔ Filtered Candidate Queue (CAs only see assigned candidates; Admins bypass all)      │
│                                                                                        │
│  [5-Tier Answer Resolution Waterfall]                                                  │
│  DOM Form Fields                                                                       │
│    ├── Tier 1: Supabase Profile Heuristics & Exact QA Bank Memory                      │
│    ├── Tier 2: Master Resume PDF Text & Hyperlink Extraction                           │
│    ├── Tier 3: Fuzzy Token Similarity Matching                                         │
│    └── Tier 5: OpenRouter / Gemini LLM Synthesis ➔ Writes Back to QA Bank             │
│                                                                                        │
│  [Playwright Execution & Live Submissions]                                             │
│  Dashboard Review ➔ Dry-Run Preview / Live Submission                                 │
│    ├── Anti-Bot Chromium (Human typing jitter, no-sandbox, disable-dev-shm-usage)      │
│    ├── Challenge Detection (Alphanumeric OTP & CAPTCHA Pause/Resume)                   │
│    └── Verification: Full-Page Web Screenshot (proofs_web) + Zoho Mail Confirmation   │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## ⚡ Quick Start

### 1. Prerequisites
- Node.js >= 20.x
- Supabase account with project credentials
- OpenRouter API key (or local Ollama)

### 2. Installation & Setup
```bash
git clone https://github.com/yaswanthnaidu-yalla-applywizz/greehouse_apply.git
cd greehouse_apply
npm install
npx playwright install chromium
```

### 3. Configure Environment Variables
Copy `.env.example` to `.env` and fill in your credentials:
```bash
cp .env.example .env
```

Key variables:
- `SUPABASE_URL` & `SUPABASE_SERVICE_KEY`: Database and storage access.
- `LLM_PROVIDER`: `openrouter` (recommended) or `ollama`.
- `OPENROUTER_API_KEY` & `OPENROUTER_MODEL`: `google/gemini-2.5-flash`.
- `WORK_HISTORY_API_URL`: `https://applywizz-ca-management.vercel.app/api/ca/work-history`.

### 4. Run the Operator Dashboard Locally
```bash
npm run dashboard
# Starts server on http://localhost:3000 (or PORT specified in .env)
```

---

## 🚂 Railway Cloud Deployment

The repository is pre-configured for Railway deployment via GitHub integration:

1. **Link Repository**: In Railway, create a new project and select **Deploy from GitHub repo**.
2. **Build Configuration**: Railway automatically detects `Dockerfile` and `railway.json`.
3. **Environment Variables**: Add the following variables in the Railway **Variables** tab:
   - `NODE_ENV`: `production`
   - `RAILWAY_ENV`: `true`
   - `SUPABASE_URL`: `https://<your-project>.supabase.co`
   - `SUPABASE_SERVICE_KEY`: `<service-role-key>`
   - `LLM_PROVIDER`: `openrouter`
   - `OPENROUTER_API_KEY`: `<your-api-key>`
   - `OPENROUTER_MODEL`: `google/gemini-2.5-flash`
   - `WORK_HISTORY_API_URL`: `https://applywizz-ca-management.vercel.app/api/ca/work-history`
   - `AUTHORIZED_EMAILS_API`: `https://applywizz-ca-management.vercel.app/api/ca/emails`
   - `ALLOWED_SIGNUP_EMAILS`: `yaswanthnaiduyalla@applywizz.ai`
4. **Healthcheck**: Configured automatically at `/api/health`.

---

## 💻 CLI Commands Reference

| Command | Purpose |
|---|---|
| `npm run dashboard` | Starts the Express REST API and Operator Web Dashboard |
| `npm run start:prod` | Runs compiled production server (`node dist/server/index.js`) |
| `npm start` | Launches full batch pipeline (scanner, profile sync, answer resolution, server) |
| `npm run start:sample` | Targeted pipeline run for sample candidate `AWL-31428` |
| `npm run dry-run` | Fills Greenhouse application in Playwright without submitting |
| `npm run submit` | Runs automated headless submission for the next ready application |
| `npm run build` | Compiles TypeScript to JavaScript in `dist/` |
| `npm test` | Runs end-to-end integration test suite |

---

## 🔒 Security & Compliance

- **No Unauthorized API Calls**: ApplyWizz profile API is never called without explicit permission; local caches and Supabase tables are prioritized.
- **Strict Data Segregation**: Non-admin CAs can only access candidates assigned to them in the work-history API; direct unauthorized requests return `403 Forbidden`.
- **Sensitive Data Exclusion**: Resumes, candidate PII, and environment files are strictly excluded from git tracking via `.gitignore`.
