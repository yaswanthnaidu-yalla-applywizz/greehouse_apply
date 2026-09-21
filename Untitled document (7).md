**Comprehensive Bug Fix & Consistency Update**

# **Comprehensive Bug Fix & Consistency Update**

**MODEL:ClaudeOpus5MODEL: Claude Opus 5**

**@AGENTS.md @rules.md @dashboard/public/operator-app.jsx @src/server/routes/applications.ts @src/server/routes/submissions.ts @src/server/routes/adminDashboard.ts @src/server/routes/manager.ts @src/server/routes/devDashboard.ts @src/server/clientDashboard.ts @src/server/index.ts @.ai/systemPatterns.md**

## **OBJECTIVE**

**Implement all confirmed bugs from the system audit in the order specified below. Do not skip any item. Preserve existing functionality unless explicitly instructed otherwise.**

**Before making changes, inspect the relevant code and verify each issue against the current implementation. Resolve conflicts between existing logic and the requirements below.**

---

# **P0 — BREAKS SUBMISSIONS**

## **P0-1: Ownership Check Rejects NULL assigned\_ca\_email → 403 for Operators**

**File: `src/server/routes/applications.ts`**

**Affected locations:**

* **Lines 309–313**  
* **Lines 510–514**  
* **Lines 771–774**

**Also update:**

* **`src/server/routes/submissions.ts:277–286`**

### **Problem**

**Ownership checks currently reject applications where `assigned_ca_email` is NULL, resulting in HTTP 403 for legitimate operators.**

### **Fix**

**Replace every ownership check using:**

**application.assigned\_ca\_email \!== req.user.email**

**With a NULL-safe, case-insensitive check:**

**application.assigned\_ca\_email \!== null &&**

**application.assigned\_ca\_email.toLowerCase() \!== req.user.email.toLowerCase()**

**Requirements:**

* **Apply this pattern to every relevant ownership check.**  
* **Normalize email comparisons using lowercase.**  
* **When `assigned_ca_email IS NULL`, the application is unassigned. Allow the owning operator to proceed.**  
* **Ensure the same logic is implemented consistently in `submissions.ts`.**  
* **Inspect related ownership checks beyond the specified lines if necessary to prevent the same bug elsewhere.**

---

## **P0-2: HTTP 403 Incorrectly Displayed as QUEUED**

**File: `dashboard/public/operator-app.jsx`**

**Affected location: Lines 1935–1940**

### **Problem**

**When a submission returns HTTP 403, the operator UI silently sets the application status to QUEUED.**

### **Fix**

* **Detect HTTP 403 responses explicitly.**  
* **Display a visible error banner:**

> **Access denied — this application is not assigned to you**

* **Do not update the local application status to QUEUED on HTTP 403\.**  
* **Preserve the actual server-side status.**  
* **Handle other submission errors appropriately without falsely displaying QUEUED.**

---

## **P0-3: DRY\_RUN\_COMPLETE Hides Submit Controls**

**File: `dashboard/public/operator-app.jsx`**

**Affected location: Lines 383–388**

### **Problem**

**`DRY_RUN_COMPLETE` is included in the `hideSubmissionActions` logic, despite already being listed as submit-capable at lines 2454–2460.**

### **Fix**

* **Remove `DRY_RUN_COMPLETE` from the status set that triggers `hideSubmissionActions`.**  
* **After a dry run completes, the operator must see Approve & Submit.**  
* **Ensure the status remains compatible with the existing submit-capable logic.**  
* **Remove the contradiction between the status display and submission controls.**

---

## **P0-4: Internal Worker Routes Lack Authentication**

**File: `src/server/index.ts`**

**Affected location: Lines 783–819**

### **Problem**

**`/api/internal/*` routes lack shared-secret authentication.**

### **Fix**

**Implement shared-secret authentication:**

1. **Add an environment variable:**  
   **INTERNAL\_API\_SECRET=**  
2. **Add a corresponding entry to `.env.example` with a clear comment.**  
3. **Service 1 must send the secret using the header:**  
   **x-internal-secret: \<INTERNAL\_API\_SECRET\>**  
4. **Service 3 must validate the header on all relevant `/api/internal/*` routes.**  
5. **If the secret is missing or incorrect, return HTTP 401\.**  
6. **Use secure constant-time comparison if practical and supported by the existing environment.**  
7. **Do not expose the secret in logs, API responses, or client-side code.**  
8. **Inspect the existing proxy and internal route architecture before implementing to ensure authentication is applied at the correct boundary.**

---

## **P0-5: OTP/CAPTCHA Displayed as "Submitting..."**

**File: `dashboard/public/operator-app.jsx`**

**Affected locations:**

* **Lines 145–153**  
* **Lines 1721–1733**

### **Problem**

**`OTP_REQUIRED` and `CAPTCHA_REQUIRED` are being remapped to APPLYING in the display layer, preventing operators from taking the required action.**

### **Fix**

**Do not remap these statuses to APPLYING.**

### **OTP\_REQUIRED**

* **Display a dedicated OTP UI.**  
* **Show an OTP input field and submit button.**  
* **Reuse the existing OTP input implementation if available.**  
* **Wire the UI to the correct submission/status handling logic.**  
* **Ensure the operator can submit the OTP and resume the application flow.**

### **CAPTCHA\_REQUIRED**

* **Display a dedicated CAPTCHA UI.**  
* **Show the message:**

> **Open browser to solve CAPTCHA**

* **Provide a button to open the browser and solve the CAPTCHA.**  
* **Reuse existing browser-opening functionality where available.**

---

# **P1 — STATISTICS & DATE CONSISTENCY**

## **P1-1: Standardize Submitted, Pending, Applied, and Failed Definitions**

**Critical: Replace the previous `completed` definition entirely. Do not retain `completed` as a separate metric.**

**Apply these definitions consistently across all dashboards, API endpoints, SQL queries, and UI labels.**

### **Canonical Definitions**

**submitted \= status \!= 'READY\_FOR\_REVIEW'**

&nbsp;

**pending \= status \= 'READY\_FOR\_REVIEW'**

&nbsp;

**applied \= status \= 'APPLIED'**

&nbsp;

**failed \= status IN ('FAILED', 'CAPTCHA\_TIMEOUT')**

### **Requirements**

**Submitted**

* **Includes every application whose status is NOT `READY_FOR_REVIEW`.**  
* **This represents everything that has moved past the operator review queue.**  
* **Do not restrict submitted to APPLIED or successful submissions.**

**Pending**

* **Includes only applications with status `READY_FOR_REVIEW`.**  
* **Represents applications waiting for operator action.**

**Applied**

* **Includes only applications with status `APPLIED`.**

**Failed**

* **Includes applications with status `FAILED` or `CAPTCHA_TIMEOUT`.**

**Completed**

* **Remove `completed` entirely.**  
* **Remove it from every API response field, SQL count, dashboard statistic, and UI label.**  
* **Replace any existing UI label "Completed" with "Submitted".**  
* **Do not retain aliases, duplicate counts, or legacy completed fields unless required for backward compatibility and explicitly documented.**

### **Apply Everywhere**

**Update all relevant logic in:**

* **`GET /api/stats`**  
* **`GET /api/admin/overview`**  
* **`GET /api/manager/dashboard`**  
* **`GET /api/dev/health`**  
* **All dashboard HTML/JSX and client-side statistics**  
* **Any shared helper functions, SQL queries, or utility functions calculating these metrics**

**Search the entire codebase for:**

* **`completed`**  
* **`countCompletedApplicationsSince`**  
* **Existing submitted/pending/applied/failed status definitions**  
* **UI labels and API response fields**

**Ensure every dashboard uses the exact same canonical definitions. Do not implement different interpretations per role.**

---

## **P1-2: Date Filters Use Incorrect Timestamp Columns**

### **Requirements**

**Use the correct timestamp columns for date-scoped queries:**

| Metric | Timestamp |
| ----- | ----- |
| **Submitted / past review queue** | **Follow the existing metric's intended date semantics; verify against the canonical definition** |
| **Applied** | **`submitted_at`** |
| **Total applications** | **`created_at`** |
| **Ready / pending applications** | **`created_at`** |

### **Fix**

* **Update `countCompletedApplicationsSince` if it exists, or remove it if completed is being eliminated.**  
* **Update `countAppliedApplicationsSince` to use `submitted_at`, not `updated_at`.**  
* **Ensure manager dashboard date filtering honors the requested date range.**  
* **Review all date-scoped SQL queries for incorrect use of `updated_at`.**  
* **Ensure start and end dates are applied consistently, including timezone handling.**  
* **Verify that all date filters produce counts aligned with the database ground truth.**

---

## **P1-3: Dev Health Applied Count Is All-Time**

**File: `src/server/routes/devDashboard.ts`**

### **Problem**

**The `applied` count is not date-scoped.**

### **Fix**

* **When a date or date range is provided, filter `applied` using `submitted_at`.**  
* **Match the behavior of the operator and admin dashboards.**  
* **Ensure the default date behavior is consistent with the other dashboards.**  
* **Do not use all-time counts when a date filter is active.**

---

## **P1-4: supabasePercent / aiPercent Divide by Zero**

**File: `src/server/routes/adminDashboard.ts`**

### **Fix**

**Guard every percentage calculation:**

**total \> 0 ? Math.round(...) : 0**

**Requirements:**

* **Apply the guard to `supabasePercent`, `aiPercent`, and any related percentage calculations.**  
* **Ensure no `NaN`, `Infinity`, or division-by-zero errors are returned.**  
* **Verify behavior when total \= 0\.**

---

# **P2 — UI CORRECTNESS**

## **P2-1: EMAIL\_PROOF\_PENDING Has No Dedicated UI State**

**File: `dashboard/public/operator-app.jsx`**

**Affected locations:**

* **Lines 384–388**  
* **Lines 507–539**

### **Fix**

**Add an explicit UI branch for `EMAIL_PROOF_PENDING`.**

**Display:**

* **Message: Waiting for email proof**  
* **Button: Get email screenshot**

**Requirements:**

* **The screenshot button must be shown based on the `EMAIL_PROOF_PENDING` status, not only when a proof URL already exists.**  
* **Do not show Approve & Submit or other submission controls for this status.**  
* **Preserve existing email proof retrieval functionality.**  
* **Ensure the UI clearly communicates that the application is waiting for proof.**

---

## **P2-2: Generic Error Message for Blocked Statuses**

**File: `dashboard/public/operator-app.jsx`**

**Affected locations:**

* **Lines 1883–1885**  
* **Lines 2493–2503**

### **Problem**

**All blocked statuses currently display:**

> **This application couldn't be submitted**

### **Fix**

**Implement status-specific UI messages:**

| Status | Required UI |
| ----- | ----- |
| **`SKIPPED`** | **`Skipped — too many fields (>35)`** |
| **`EXPIRED`** | **`Job posting has expired`** |
| **`CAPTCHA_TIMEOUT`** | **`CAPTCHA timed out — resubmit to retry`** |
| **`OTP_REQUIRED`** | **OTP input field and submit button** |
| **`CAPTCHA_REQUIRED`** | **CAPTCHA action button** |

**Requirements:**

* **Do not display the generic submission failure message for the statuses above.**  
* **Reuse the dedicated OTP/CAPTCHA UI from P0-5.**  
* **Ensure the correct status-specific branch takes precedence over generic error handling.**

---

## **P2-3: Non-Greenhouse Hostnames in Database**

### **Problem**

**The audit identified:**

* **3 rows containing `www.crossriver.com`**  
* **1 row containing `localhost:57370`**

**These URLs should not be submitted as Greenhouse applications and must be marked `SKIPPED`.**

### **Fix**

**Execute the following one-time SQL cleanup through the Supabase CLI:**

**UPDATE gh\_candidate\_applications**

**SET**

&nbsp;&nbsp;**status \= 'SKIPPED',**

&nbsp;&nbsp;**error\_message \= 'Non-Greenhouse job URL'**

**WHERE job\_url NOT SIMILAR TO '%greenhouse\\.io%'**

&nbsp;&nbsp;**AND job\_url NOT LIKE '%grnh.se%'**

&nbsp;&nbsp;**AND status \= 'READY\_FOR\_REVIEW';**

**Requirements:**

* **Inspect the SQL and database environment before executing.**  
* **Run the cleanup only against the intended database/environment.**  
* **Report the exact number of rows updated.**  
* **Verify that the affected non-Greenhouse URLs have the expected status.**  
* **Do not modify already processed applications unless explicitly required by the cleanup criteria.**  
* **Review the ingestion/validation logic and prevent future non-Greenhouse URLs from entering the submission workflow.**

---

# **AFTER ALL FIXES — VALIDATION**

## **1\. Typecheck and Build**

**Run:**

**npm run typecheck && npm run build**

**Both commands must exit with code `0`.**

**If either fails:**

* **Investigate the root cause.**  
* **Fix the issue.**  
* **Re-run validation.**  
* **Report any unresolved failures honestly.**

---

## **2\. Database Verification**

**Run the following checks through the Supabase CLI, using the correct supported command syntax for the project environment.**

### **Check unassigned applications**

**SELECT COUNT(\*)**

**FROM gh\_candidate\_applications**

**WHERE assigned\_ca\_email IS NULL**

&nbsp;&nbsp;**AND status \!= 'SKIPPED';**

**Verify that NULL `assigned_ca_email` does not cause ownership checks to reject the owning operator.**

### **Check non-Greenhouse URLs**

**SELECT status, COUNT(\*)**

**FROM gh\_candidate\_applications**

**WHERE job\_url NOT SIMILAR TO '%(greenhouse\\.io|grnh.se)%'**

**GROUP BY status;**

**Verify that the intended non-Greenhouse URLs have been cleaned up.**

### **Report**

* **Rows updated by the cleanup query.**  
* **Results of both verification queries.**  
* **Any remaining anomalies or mismatches.**

---

## **3\. Search for Inconsistencies**

**Before committing, search the entire codebase for:**

* **All `completed` references.**  
* **All existing submitted/pending/applied/failed definitions.**  
* **Ownership checks involving `assigned_ca_email`.**  
* **Incorrect date filters using `updated_at`.**  
* **Percentage calculations without zero guards.**  
* **UI status remapping for OTP/CAPTCHA.**  
* **Internal routes without authentication.**

**Fix any relevant inconsistencies discovered during the audit.**

---

# **GIT WORKFLOW**

## **Branch**

**Use:**

**fix/stat-and-flow-inconsistencies**

**Requirements:**

1. **Confirm the current branch and working tree before making changes.**  
2. **Do not overwrite unrelated user changes.**  
3. **Implement and validate all fixes.**  
4. **Commit the changes to the specified branch.**  
5. **Push the branch to the remote repository.**  
6. **Do not merge into `main`.**

**If the branch does not exist, create it from the appropriate up-to-date base branch without losing existing work.**

---

# **MANUAL SMOKE TEST — REQUIRED BEFORE MERGING**

**Do not merge to `main` until manual smoke testing on staging confirms all five scenarios:**

### **1\. Operator Submission**

* **Operator can submit an application without incorrectly receiving "Access denied".**  
* **NULL `assigned_ca_email` does not block the legitimate owning operator.**

### **2\. Dry Run Completion**

* **`DRY_RUN_COMPLETE` displays Approve & Submit.**  
* **Submission controls are not incorrectly hidden.**

### **3\. Email Proof Pending**

* **`EMAIL_PROOF_PENDING` displays Waiting for email proof.**  
* **Get email screenshot button is visible.**  
* **Approve & Submit controls are not displayed.**

### **4\. Admin Statistics**

* **Admin overview statistics match database ground-truth counts.**  
* **Submitted, pending, applied, and failed definitions are consistent.**  
* **No `completed` metric or label remains.**

### **5\. Manager Date Filtering**

* **Manager dashboard `submitted` count honors the correct date range.**  
* **Applied counts use `submitted_at`.**  
* **Total/pending counts use `created_at`.**  
* **Results match database ground truth.**

---

# **IMPLEMENTATION RULES**

* **Follow the existing project architecture, coding standards, and patterns in `AGENTS.md`, `rules.md`, and `.ai/systemPatterns.md`.**  
* **Do not introduce unnecessary features or unrelated refactoring.**  
* **Do not silently ignore errors.**  
* **Do not claim tests or SQL queries were executed unless they actually ran successfully.**  
* **Preserve backward compatibility where required, but remove `completed` as instructed from API responses and UI.**  
* **Use consistent status definitions across every role and dashboard.**  
* **Review your changes for security, correctness, and regressions before committing.**

## **FINAL RESPONSE**

**After implementation, provide a concise report containing:**

1. **Summary of fixes completed.**  
2. **Files modified.**  
3. **Typecheck and build results.**  
4. **SQL cleanup result and verification output.**  
5. **Git branch, commit hash, and push status.**  
6. **Any unresolved issues or blockers.**  
7. **Manual smoke tests completed vs. pending.**

**Execute the fixes now. Do not stop at analysis or provide only recommendations.**

&nbsp;