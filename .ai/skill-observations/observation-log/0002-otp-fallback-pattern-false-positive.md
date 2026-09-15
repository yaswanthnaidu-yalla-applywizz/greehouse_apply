---
id: 2
title: "Permissive fallback matcher turns no-result into confident wrong-result (Zoho OTP)"
status: actioned
type: internal
skill: []
proposes_skill: []
siblings_checked: "none: no skill family"
area: "Zoho OTP extraction + email proof reliability"
date: 2026-09-15
session_context: "Added verbose step-by-step logging to zohoReader.ts / zoho-connector.ts and ran the AWL-31428 OTP lookup"
parked_until:
resolved: 2026-09-15
resolution: "Added isGreenhouseOtpEmail sender/subject/company gate before extraction; scan limit 3 to 15; unified on parseZohoEmailTimestamp; explicit reason on no-match. Narrowing the population then exposed a SECOND defect in the same family: on the real Prometheus email the extractor returned the candidate name Akshitha instead of NgW4NT62, because Pattern 1 required label-code adjacency (Greenhouse writes an intervening clause) and Pattern 2 accepted any mixed-case token. Added Pattern 0 for Greenhouse copy-paste wording and tightened Pattern 2 to require a digit AND a letter. Verified end-to-end against the live AWL-31428 mailbox."
reference: ".ai/skill-observations/evidence/0002-zoho-otp-debug.log, .ai/skill-observations/evidence/0002-zoho-otp-debug-fixed.log"
---

**Issue:** Verbose logging was added purely for diagnosis, and the first real run exposed a latent correctness bug rather than a flow problem. `extractOtpCode` Pattern 2 (`/\b([A-Za-z0-9]{8})\b/`, accepted when the word contains a digit) matched `jobs2web` inside an unrelated PG&E job-alert email and `fetchLatestOtp` returned `{ success: true, otp: "jobs2web" }`. Two compounding causes: (1) the fallback pattern is broad enough to match ordinary prose, defended only by a hardcoded stop-word list; (2) `fetchLatestOtp` inspects the newest 3 messages with no sender or subject filter, so the genuine `no-reply@us.greenhouse-mail.io` "Security code for your application to…" mails sitting lower in the list were never reached. The failure is silent and confident — a wrong OTP is indistinguishable from a right one to the caller, and `liveSubmit` would type it into Greenhouse.

**Suggested improvement:** Scope the search before extracting: filter candidate messages by sender (`greenhouse-mail.io`) and/or subject ("security code", "verification code") and pass the company name into `fetchLatestOtp` the way `captureConfirmationEmailContent` already takes `companyName`. Keep the broad standalone-token pattern only as a last resort *within* an already-identified OTP email, never across arbitrary inbox mail. Also return a confidence/source marker so the caller can distinguish a labeled-pattern hit from a fallback guess.

**Second instance (same session, found by the fix):** With the gate in place the flow opened the correct Greenhouse email, whose body read "Copy and paste this code into the security code field on your application: NgW4NT62" — and the extractor returned `Akshitha`. Pattern 1 required the code to sit immediately after the label, but Greenhouse separates them with a clause, so the specific pattern missed and control fell through to the permissive one, which accepted the first mixed-case token (the candidate's own name, present in the greeting of every such email). Fixing the scope did not fix the extractor; it only made the extractor's own defect reachable and visible.

**Principle:** A fallback branch broad enough to always match does not improve recall — it converts "no result" into "wrong result", which is strictly worse because it removes the caller's ability to detect failure. When a matcher has a permissive last-resort pattern, the population it runs over must be narrowed by an independent signal (sender, subject, provenance) first; a stop-word list is a blocklist standing in for a missing scope, and blocklists silently fail open on every input nobody thought of. Corollary: adding diagnostic logging to a "reliability" problem is worth doing before any fix — the instrumentation located a correctness defect that no amount of flow-level reasoning had surfaced.
