---
id: 10
title: "A persistent Playwright page inherits the previous lookup's UI state"
status: actioned
type: open-source
skill: []
proposes_skill: []
siblings_checked: "none: no skill family"
area: "shared browser session between sequential tasks"
date: 2026-09-15
session_context: "OTP lookups failing or matching the wrong mailbox because the Zoho connector filter still held the last email"
parked_until:
resolved: 2026-09-15
resolution: "fetchLatestOtp now calls resetUiBeforeLookup (goto connector root, wait for filter, clear input). If the users list is still empty, one page.reload() retry then not-found. Numbered [Zoho] Step 1–8 logs added (uncommitted at session end)."
reference:
---

**Issue:** `zohoReader` keeps one Playwright page across OTP lookups. After a search, the filter input and selected mailbox stayed as the previous candidate. The next `fetchLatestOtp` typed a new email on top of leftover text (or searched an already-filtered list) and either found zero rows or the wrong inbox. `idlePage()` going to `about:blank` was not enough: restoring the URL did not reset SPA widget state.

**Suggested improvement:** Before every lookup on a reused page, navigate to the app root, wait for the known ready selector, and clear the filter explicitly. Treat an empty result after that reset as a possible render glitch and retry once with `page.reload()` before returning not-found.

**Principle:** A long-lived browser session is not a clean slate. Sequential tasks that share a Page inherit DOM and SPA state from the last task; "the input should be empty" is an assumption about the previous run, not a property of this one. Reset the UI as a named step of the operation, and do not treat a first empty result as proof the data is missing.
