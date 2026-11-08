---
name: fada
description: Use when the user invokes "fada", "fada-filter", or "fada-failed", asks to diagnose filtered out or non-auto-queued applications, inspect why fields were unresolved or resolved by AI (Tier 5) instead of Tiers 1-4, download and visually inspect failure screenshots from production DB 2, or run systematic root-cause diagnostics on submission failures.
---

# FADA (Filtered & Application Diagnostics Analyzer)

FADA is the dedicated project diagnostic skill for analyzing production DB 2 application runs, identifying why applications get filtered out or stuck in operator review, and diagnosing submission failures using verified visual evidence from screenshots.

---

## Invocation Modes & Triggers

| Trigger | Description | Target Workflows |
|---|---|---|
| `fada` | Unified full audit | Runs **both** `fada-filter` and `fada-failed` in sequence. |
| `fada-filter` | Filter & Resolver deep dive | Diagnoses `FILTERED_OUT` and `READY_FOR_REVIEW` applications, unresolved fields, and AI (Tier 5) fallbacks vs. Tiers 1–4. |
| `fada-failed` | Failure & Visual screenshot audit | Downloads 100% of failure screenshots from DB 2, inspects visual ground truth, groups root causes, and prescribes fixes. |

---

## Interaction & Parameter Prompting Protocol

Before running any diagnostics, ensure the required parameters are known. **Always prompt the user if they were not provided in the invocation:**

1. **Time Range (Mandatory for all triggers):**
   - If not specified by the user, ask:
     > *"Please specify the time range or date to inspect in DB 2 (e.g., 'today', 'yesterday', '2026-11-06', or an ISO range)."*
   - Convert dates using Asia/Kolkata (IST, UTC+5:30) day bounds:
     - `today`: Today's 00:00:00 IST to present.
     - `yesterday`: Yesterday's 00:00:00 IST to 23:59:59 IST.
     - `YYYY-MM-DD`: That specific calendar day in IST.

2. **Original CSV Path (Mandatory for `fada` and `fada-filter`):**
   - If not specified by the user, ask:
     > *"Please provide the file path to the original CSV used for ingestion."*

---

## Engine Execution

The skill is powered by the automated engine at `.agents/skills/fada/scripts/fada-engine.ts`. Run it via `npx tsx`:

```bash
# Mode: Full audit (Both Filter & Failed)
npx tsx .agents/skills/fada/scripts/fada-engine.ts --action=all --csv="<path-to-csv>" --since="<time-range>"

# Mode: Filter diagnostics only
npx tsx .agents/skills/fada/scripts/fada-engine.ts --action=filter --csv="<path-to-csv>" --since="<time-range>"

# Mode: Failed submissions diagnostics only
npx tsx .agents/skills/fada/scripts/fada-engine.ts --action=failed --since="<time-range>"
```

The engine connects to production DB 2, downloads all screenshots, parses CSVs and JSON fields, and outputs JSON summaries in `.ai/diagnostics/`.

---

## Track 1: `fada-filter` Deep Dive

### 1. Ingestion & Match
1. Reads the original CSV provided by the user and normalizes job URLs (strips tracking query params like `gh_jid`, `token`, `utm_*`).
2. Queries DB 2 `gh_candidate_applications` joined with `profiles` to map CSV rows to applications.
3. Groups applications into:
   - `FILTERED_OUT`: Hard-dropped by `src/resolver/needsReview.ts` (required AI fields > 3 OR unresolved required fields > 3).
   - `READY_FOR_REVIEW`: Non-auto-queued applications held for manual Career Associate review (1–3 required AI or unresolved fields).
   - `AUTO_QUEUED`: Successfully queued without review (0 required AI and 0 unresolved fields).
   - Dropped before DB: CSV rows missing from DB (e.g. invalid URL, duplicate check, or scan failure).

### 2. Unresolved & AI Fields Extraction
Inspects `resolved_fields` JSON for all `FILTERED_OUT` and `READY_FOR_REVIEW` applications:
- **Unresolved fields (`source = 'unresolved'` or empty `value`):** Fields where all 5 tiers failed.
- **AI fields (`source = 'ai'`):** Fields synthesized by LLM (Tier 5).

### 3. Incorrectly Answered Resolved Fields Inspection
Evaluates all populated answers across applications to detect factually wrong, policy-violating, or invalid answers:
- **Candidate Ground Truth Contradictions:**
  - **Sponsorship Inversion:** Question asks if candidate requires visa sponsorship; answered `Yes` when `profiles.requires_sponsorship` is `false` (or answered `No` when profile requires sponsorship).
  - **Work Authorization Inversion:** Question asks if candidate is legally authorized to work in the US; answered `No` when candidate holds US Citizenship, Green Card, OPT, H1B, or EAD.
- **System Policy Violations:**
  - **SMS / Marketing Consent Violation:** Promotional/recruiting SMS consent answered `Yes` / affirmative instead of system-mandated `No`.
  - **Mandatory Terms / Certification Rejection:** Mandatory applicant certification or privacy policy answered `No` / unchecked, triggering automatic rejection.
- **Control & Data Validity:**
  - **Invalid Choice Option (Hallucination):** Select or radio field populated with an answer string that is not among the form control's scanned `options`.
  - **Placeholder Leakage:** Unselected dropdown placeholder saved as an answer (e.g., `"Select..."`, `"-- Select --"`, `"Please choose"`).
  - **Corrupted Sentinels:** String representations of missing data or JS objects (e.g., `"undefined"`, `"null"`, `"[object Object]"`).

### 4. Systematic Debugging against Tiers 1–4
For every high-concentration unresolved or AI field, determine **why it fell through**:
- **Tier 1 (Profiles & Exact Fingerprint Match):**
  - Check `profiles`: Does the profile contain the fact (e.g., `requires_sponsorship`, `work_authorization`, `phone`, `current_location`, `demographics`, `raw_api_payload`)?
  - If the fact existed, why did Tier 1 miss? (E.g. choice option alignment failed in `src/utils/choiceOptions.ts`, or fingerprint mismatch in `src/resolver/fingerprint.ts`).
- **Tier 2 (Parsed Resume Cache):**
  - Check `candidate_resume_parsed`: Does the cached resume text/facts contain the institution, degree, employment dates, or skills?
  - If it was present, why did Tier 2 miss? (E.g. date format mismatch, custom dropdown instead of text).
- **Tier 3 / 4 (QA Bank Semantic & Fuzzy Match):**
  - Check `candidate_qa_bank`: Did similar questions exist in the QA bank? Did Fuse.js or semantic similarity score drop below threshold (< 0.82)?
- **Deterministic Policy Registry:**
  - Did a deterministic policy exist (SMS marketing opt-out, availability date +7 days, work authorization polarity)? Why didn't it match the question label?

### 5. Output Findings
- **Executive Summary:** CSV rows, Ingested, Filtered Out count, Ready For Review count, Auto-Queued count.
- **Incorrectly Answered Fields Table:** Application ID, Candidate, Company, Question Label, Populated Answer, Ground Truth / Expected, Inaccuracy Category, Severity.
- **Unresolved Questions Table:** Question Label, Control Type, Required (Y/N), Count, Root Cause Diagnosis.
- **AI-Resolved Questions Table:** Question Label, Control Type, Count, Can Tier 1–4 Resolve It? Recommended Remediation.
- **Resolver Recommendations:** Specific policy additions, regex/alias updates in `choiceOptions.ts`, or QA bank seeding.

---

## Track 2: `fada-failed` Deep Dive

### 1. 100% Screenshot Download (Zero Sampling)
- The engine fetches all `FAILED` applications in DB 2 for the time range.
- Downloads **100% of failure screenshots** via `proof_failed_url` into `.ai/diagnostics/failed_screenshots/<date>/<id>_<company>.png`.
- Produces `manifest.json` detailing each application and its local image path.

### 2. Visual Inspection via `read_file`
> [!IMPORTANT]
> **Never rely solely on `error_message` or `gh_failure_diagnostics` table.** Error messages like "Timeout" or "Element not found" are often downstream symptoms. The screenshot shows the visual ground truth on the actual page.

The agent must use `read_file` on downloaded screenshots to inspect the actual DOM state at failure:
- **Challenge / Bot Wall:** Cloudflare Turnstile widget present, reCAPTCHA audio challenge, or hCaptcha iframe.
- **Form Validation Errors:** Specific red-bordered fields or inline error text (e.g., "This field is required", "Please enter a valid phone number", "Please attach a cover letter").
- **Unchecked Mandatory Consent:** Privacy policies, EEOC acknowledgements, or background check checkboxes left unchecked.
- **Uncommitted Custom Selects:** Greenhouse Remix / React-Select dropdowns showing typed text with an open menu instead of a selected pill.
- **Job Status:** Closed job banner ("This position is no longer accepting applications", 404).
- **OTP Screen:** Unresolved security code modal, expired OTP notice, or polling timeout.
- **Asset / Resume Failure:** S3 403 Forbidden or failed file upload widget.

### 3. Classification & Grouping
Group all failures by **verified visual root cause** with exact application counts:
```text
Visual Failure Breakdown:
1. Mandatory Consent Checkbox Missed: X apps
2. Cloudflare Turnstile / Bot Challenge: Y apps
3. Custom React-Select Uncommitted: Z apps
4. Closed Job / Inactive Link: W apps
5. OTP Polling / Verification Timeout: V apps
```

### 4. Systematic Debugging & Fixes
For each visual failure cluster:
- Pinpoint the exact file responsible (`src/submitter/formFiller.ts`, `src/submitter/liveSubmit.ts`, `src/submitter/ashbySubmit.ts`, `src/services/otpResolutionService.ts`).
- Classify the issue: **Code Bug** vs. **Data Fault** vs. **Site/ATS Mutation**.
- Provide concrete, surgical code diffs or policy updates to prevent recurrence.

---

## Report Presentation Template

When completing a FADA session, produce a structured markdown artifact in `.ai/diagnostics/` and present the findings:

```markdown
# FADA Diagnostic Report — <Date Range>

## 1. Executive Summary
- **Original CSV Rows:** <count>
- **Total Ingested Applications:** <count>
- **Auto-Queued (Direct Submission):** <count> (<%>)
- **Ready for Review (Non-Auto-Queued):** <count> (<%>)
- **Filtered Out:** <count> (<%>)
- **Failed Submissions:** <count> (<%>)

## 2. Filter & Resolver Diagnostics (`fada-filter`)
### Incorrectly Answered Resolved Fields
| Application / Candidate | Company | Question Label | Populated Answer | Expected / Ground Truth | Inaccuracy Category | Severity |
|---|---|---|---|---|---|---|
| ... | ... | ... | ... | ... | ... | ... |

### Top Unresolved Questions
| Question Label | Type | Required | Count | Root Cause Diagnosis |
|---|---|---|---|---|
| ... | ... | ... | ... | ... |

### AI Questions Eligible for Tiers 1–4 Resolution
| Question Label | Type | Count | Potential Tier | Fix / Remediation |
|---|---|---|---|---|
| ... | ... | ... | ... | ... |

### Why Auto-Queue Rate Dropped
- <Root cause analysis of resolver bottlenecks>

## 3. Failure & Visual Screenshot Diagnostics (`fada-failed`)
- **Total Screenshots Analyzed:** <count> (100% verified)

### Verified Visual Failure Categories
| Category | Visual Evidence | Count | Module & Line | Fix Recommendation |
|---|---|---|---|---|
| Consent Checkbox Missed | Red error under "I agree..." | X | `src/submitter/formFiller.ts` | Add affirmative label regex |
| Uncommitted React Select | Dropdown open with filter text | Y | `src/submitter/formFiller.ts` | Verify committed option click |
| Turnstile Settlement | Unsettled Cloudflare spinner | Z | `src/submitter/ashbySubmit.ts` | Increase pre-submit settle wait |

## 4. Prescribed Code & Policy Fixes
- [ ] Action item 1
- [ ] Action item 2
```
