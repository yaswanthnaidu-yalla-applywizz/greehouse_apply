# Investigation Report: False-Failed Submission Status Diagnostics (Issue 2.5)

**Date:** 2026-11-12  
**Author:** AI Subagent (`task4-investigation`)  
**Scope:** Read-Only Audit of Confirmation Token Detection & DB2 False-Failed Status Incidents  
**Target:** `src/submitter/otpSession.ts`, `src/submitter/liveSubmit.ts`, and Supabase Production DB2 (`gh_candidate_applications`, `gh_application_events`, `gh_failure_diagnostics`)

---

## 1. Executive Summary

This investigation analyzed whether Greenhouse submissions that display the confirmation text:
> *"Thanks for applying! We will be in touch about next steps if there is a fit."*

are erroneously categorized as `FAILED` (specifically `SUBMIT_CONFIRMATION_TIMEOUT`) due to token-matching omissions in `src/submitter/otpSession.ts`.

### Key Findings
1. **The confirmation phrase IS already matched:** `CONFIRMATION_TOKENS[1]` is `'thanks for applying'`. The case-insensitive substring search in `verifySubmissionSignals` matches this phrase cleanly.
2. **Zero false-failures from verification timeouts:** In DB2, exactly 17 applications failed with `VERIFICATION_TIMEOUT` (`"This submission took too long to confirm. Please try submitting this job again."`). In **all 17 cases**, `proof_web_url` was `NULL`, and failure screenshots confirmed the browser was still stalled on the unsubmitted form page (`Job Application for ...`), not a confirmation page.
3. **The true root cause of `status = 'FAILED'` with `proof_web_url IS NOT NULL` (57 rows):**
   - **Operator Re-queue of Already-Applied Jobs (Primary Cause, ~85%):** Because the operator dashboard queue historically did not filter out `status = 'APPLIED'` applications (addressed in Task 1 of this sprint), operators repeatedly re-queued already-submitted jobs (e.g., `APPLIED -> QUEUED` by human operators `rathnamalam@applywizz.com`, `akhilakarike@applywizz.ai`). Subsequent runs on already-submitted jobs failed and demoted the status to `FAILED`, leaving the original `proof_web_url` intact.
   - **Double-Dequeue / Concurrent Worker Race Condition (~15%):** In multiple cases (e.g. `2ff7cbfc-007f-415d-9a10-b1342e2164a1`), two submitter workers picked up the same application within 24 seconds. Worker 1 succeeded, captured `proof_web_url` and `proof_email_json`, and marked the job `APPLIED`. Worker 2, running in parallel against the now-submitted form, timed out ~45 seconds later and blindly executed `updateStatus(id, 'FAILED')`, overwriting `APPLIED` with `FAILED`.

---

## 2. Confirmation Phrase Match Analysis

### 2.1 Current Implementation (`src/submitter/otpSession.ts:298-350`)

The exact `CONFIRMATION_TOKENS` array defined in `verifySubmissionSignals`:
```typescript
const CONFIRMATION_TOKENS = [
  'thank you for applying',
  'thanks for applying',
  'your application has been submitted',
  'track your application',
  'application received',
  'we have received your application',
  'application submitted',
];
```

The signal verification logic:
```typescript
// Signal 1: Document title
const title = await page.title().catch(() => '');
if (/thank you for applying|thanks for applying|application submitted|application received/i.test(title)) {
  return { verified: true, signal: `document.title matches: "${title}"` };
}

// Signal 2: Current URL navigation
const currentUrl = page.url();
if (
  currentUrl.includes('/confirmation') ||
  (currentUrl.includes('/jobs/') && currentUrl.includes('/applied')) ||
  currentUrl.includes('status=submitted')
) {
  return { verified: true, signal: `confirmation URL reached: ${currentUrl}` };
}

// Signal 3: DOM body text tokens
const bodyText: string =
  (await page.evaluate<string>(() => (document.body ? document.body.innerText.toLowerCase() : '')).catch(() => '')) || '';
for (const token of CONFIRMATION_TOKENS) {
  if (bodyText.includes(token)) {
    return { verified: true, signal: `body text token matched: "${token}"` };
  }
}
```

### 2.2 Token Matching Test
- **Input Text:** `"Thanks for applying! We will be in touch about next steps if there is a fit."`
- **Normalized:** `"thanks for applying! we will be in touch about next steps if there is a fit."`
- **Evaluation:**
  - `bodyText.includes('thank you for applying')` → `false`
  - `bodyText.includes('thanks for applying')` → **`true`** (Matches token index `1`)
- **Conclusion:** Any page displaying this text in `document.body` triggers immediate confirmation via Signal 3 (or Signal 1 if reflected in title). There is **no missing token** for this phrase.

---

## 3. Production DB2 Audit Metrics

Queries executed against production DB 2 (`gh_candidate_applications`, `gh_application_events`):

| Metric | Count | Details |
|---|---|---|
| Total `status = 'FAILED'` applications | **4,266** | Across all history |
| `FAILED` with `error_message ILIKE '%SUBMIT_CONFIRMATION_TIMEOUT%'` | **0** | Normalized by `operatorErrorMessages.ts` |
| `FAILED` with `error_message = 'This submission took too long to confirm...'` | **17** | `VERIFICATION_TIMEOUT` |
| Verification timeouts with `proof_web_url IS NOT NULL` | **0** | **0% false-failure rate** among verification timeouts |
| Total `FAILED` with `proof_web_url IS NOT NULL` | **57** | 38 Greenhouse, 19 Ashby |
| `FAILED` with both `proof_web_url` AND `proof_failed_url` | **55** | Dual proof signature |

### 3.1 Verification Timeout Audit (17 Rows)
Sample of rows where `error_message = 'This submission took too long to confirm. Please try submitting this job again.'`:
- `c77aa363-b941-4ae1-b618-25c7e0e9c461` (Warehouse Anywhere): `proof_web_url = null`, pageUrl = form page (`Careers - Warehouse Anywhere`)
- `b5154c8d-9a98-47b9-a962-3df33d228d97` (Maven Robotics): `proof_web_url = null`, pageUrl = form page (`Job Application for Robotics AI Research Engineer...`)
- `dcde17ef-fea1-4b72-8ef8-a2a399a6f6f6` (Secretariat): `proof_web_url = null`, pageUrl = form page
- `b847bbff-9b0a-4763-9b9e-1b87cc1182c3` (GitLab): `proof_web_url = null`, pageUrl = form page
- `1905d12a-664d-499a-b2c4-67d966310626` (Maven Robotics): `proof_web_url = null`, pageUrl = form page

**Finding:** In 100% of the 17 verification timeout cases, the page never reached a confirmation state; the browser remained on the job form page until timeout.

---

## 4. Root Cause of the 57 `FAILED` Applications with `proof_web_url`

The investigation inspected `gh_application_events` for the 57 applications that had both `status = 'FAILED'` and `proof_web_url IS NOT NULL`. Two distinct non-token causes were identified:

### 4.1 Primary Cause: Operator Re-Queue of Previously `APPLIED` Applications
Applications submitted and verified days earlier were re-queued by operators who saw them in the dashboard queue (due to missing query filters):

**Example: `0286cfe8-b53b-4368-9379-f62f459a1a10` (Rockstar Games)**
- **2026-11-09 10:14:20:** Application submitted successfully, transitioned `EMAIL_PROOF_PENDING`. Web proof captured.
- **2026-11-09 10:15:40:** Confirmation email verified. Status transitioned to `APPLIED`.
- **2026-11-09 10:30:17 (15 minutes later):** Operator `rathnamalam@applywizz.com` clicked Queue in the dashboard (`APPLIED -> QUEUED`), re-enqueuing the application 4 times.
- **2026-11-09 10:33:04:** Submitter worker executed against an already-submitted job form, timed out on duplicate submission, and wrote `status = 'FAILED'`.
- **Result:** Status became `FAILED`, but `proof_web_url` (from 10:14) was retained.

**Example: `000da2d1-81fe-4f5f-af52-1370233cddb8` (Schrödinger)**
- **2026-11-08 20:11:20:** Status transitioned to `APPLIED`.
- **2026-11-09 10:41:09 (14 hours later):** Operator `akhilakarike@applywizz.ai` re-queued (`APPLIED -> QUEUED`).
- **2026-11-09 11:03:01:** Second run failed with `Required fields not committed: Country` and marked `FAILED`.

### 4.2 Secondary Cause: Concurrent Submitter Double-Dequeue Race Condition
In 8 cases, two submitter pool workers dequeued the identical application within seconds of each other.

**Example: `2ff7cbfc-007f-415d-9a10-b1342e2164a1` (Shields Health Solutions)**
- **12:26:00:** Worker 1 starts (`QUEUED -> APPLYING`).
- **12:26:24:** Worker 2 starts in parallel (`QUEUED -> APPLYING`).
- **12:27:16 / 12:27:33:** Both hit OTP prompt (`OTP_REQUIRED`).
- **12:28:02:** Worker 1 verifies submission (`EMAIL_PROOF_PENDING`) and captures `proof_web_url`.
- **12:28:17:** Worker 1 verifies confirmation email and transitions row to `APPLIED` with `proof_email_json`.
- **12:28:57 (40 seconds later):** Worker 2 times out waiting for OTP confirmation on the already-submitted form.
- **12:29:01:** Worker 2 blindly executes `updateStatus(targetAppId, 'FAILED')` with `[OTP_SUBMISSION:UNVERIFIED]`.
- **Result:** The successfully applied application was demoted from `APPLIED` to `FAILED`. Both `proof_web_url` AND `proof_email_json` remain on the row as incontrovertible proof of actual submission success.

---

## 5. Submitter Guard Inspection (`src/submitter/liveSubmit.ts`)

### 5.1 `shouldCapturePreCloseFailureScreenshot`
```typescript
export function shouldCapturePreCloseFailureScreenshot(
  terminalStatus: string | null | undefined,
  screenshotAlreadyCaptured: boolean
): boolean {
  if (screenshotAlreadyCaptured) return false;
  if (
    terminalStatus === 'FILTERED_OUT' ||
    terminalStatus === 'SKIPPED' ||
    terminalStatus === 'APPLIED' ||
    terminalStatus === 'EMAIL_PROOF_PENDING' ||
    terminalStatus === 'OTP_REQUIRED'
  ) {
    return false;
  }
  return true;
}
```
- In `liveSubmit.ts`, when a confirmation timeout occurs:
  1. `screenshotCaptured` is set to `true` (line 1333) when `captureFailedScreenshot` uploads to `proofs_failed`.
  2. In the `finally` block (line 1858), `shouldCapturePreCloseFailureScreenshot(terminalStatus, screenshotCaptured)` receives `screenshotAlreadyCaptured: true` and immediately returns `false`.
  3. Pre-close screenshot capture is correctly bypassed.

### 5.2 Legitimacy of `proof_web_url` on Timeout Rows
- `proof_web_url` is **never** written on failure or timeout in `liveSubmit.ts` or `ashbySubmit.ts`. It is strictly written inside `if (verification.verified)` branches.
- Therefore, a row cannot legitimately receive `proof_web_url` from a run that ended in `SUBMIT_CONFIRMATION_TIMEOUT`.
- Every row with `status = 'FAILED'` and `proof_web_url IS NOT NULL` is the artifact of an earlier (or concurrent) successful run that was subsequently overwritten by a failing run.

---

## 6. Recommendations & Preventive Actions

1. **Frontend / Backend Queue Filtering (Task 1 & Task 2 of this plan):**
   - Filtering `APPLIED`, `EMAIL_PROOF_PENDING`, and `FAILED` from operator review routes (`candidates.ts`) and de-duplicating by `job_url` directly eliminates Root Cause 1 (operators inadvertently re-submitting already-applied jobs).
2. **Database Status Guard in `updateStatus` (Future Architecture Improvement):**
   - In `src/db/applications.ts:updateStatus`, add an atomic state guard: never permit transitions to `FAILED` or `QUEUED` if the current status in DB is already `APPLIED`, unless explicitly requested with a `force: true` parameter.
3. **Submitter Pool Dequeue Concurrency Lock:**
   - In `SubmitterPool`, ensure that `getNextQueuedApplicationForRoundRobin` marks the application as `APPLYING` atomically within the database query (or via `FOR UPDATE SKIP LOCKED`) so two workers can never dequeue the same application simultaneously.
