---
id: 20
title: "A one-file UI change needing data its tab's endpoint does not return must source it from a sibling endpoint - and derive count and list from the same fetch"
status: open
type: open-source
skill: []
proposes_skill: []
siblings_checked: "0003 covers specs naming things that do not exist; here every named thing existed and the constraint was the opposite - the data lived outside the single file the task allowed. 0016 is about checks passing on the wrong shape; here nothing was checked wrongly, a payload had to be found."
area: "implementing a UI feature under an only-edit-this-file constraint when the tab's own endpoint lacks the fields"
date: 2026-09-18
session_context: "Reports Applied column + modal in dashboard/public/manager.html; GET /api/manager/reports perOperator[] carries no applied count and no job list, so the data was composed client-side from GET /api/manager/dashboard rows[].completedApplications[] filtered to status === 'APPLIED'"
parked_until:
resolved:
resolution:
reference: "dashboard/public/manager.html loadReports + AppliedModal; src/server/clientDashboard.ts detailFor(application, true) and hydrateApplicationProofUrls applied only to APPLIED rows"
---

**Issue:** A task scoped to a single HTML file asked for an Applied column and an applied-jobs modal with proof links on the Reports tab. The tab's own endpoint returned per-operator counts only - no applied count, no job list, no proof URLs. The same page already consumed a second endpoint whose per-client detail arrays did contain APPLIED rows with server-hydrated proof URLs, but two details made name-level reuse unsafe: proof URL hydration on that endpoint is status-conditional (only APPLIED rows get signed URLs), and the detail rows carry both snake_case and alternate grouping keys (assignedToEmail / ca_email / assigned_ca), so picking the operator key by field name alone could silently group under empty strings. Separately, the column count and the modal list are two renderings of one number; sourcing them from different requests would let them disagree after a refresh race.

**Suggested improvement:** When a file-constrained UI feature needs fields the tab's endpoint does not return, scan the sibling endpoints the same page already calls for the exact shape - including conditional hydration rules and which key actually groups the rows - and derive every figure (count and list) from that single payload in one state update. State the compromise in a code comment so a later endpoint upgrade knows what to replace.

**Principle:** A single-file constraint does not shrink the data requirement; it only moves the sourcing problem client-side. The reusable check is: for each field the feature renders, name the endpoint and the key path that supplies it, confirm the server actually populates it in every state the UI can render (not just the happy path), and make all derived figures children of one fetch so the UI cannot contradict itself.
