---
id: 25
title: "Validation permission denial must be flushed before recovery attempts"
status: open
type: open-source
skill: task-observer
proposes_skill: []
siblings_checked: "0018 (verification coverage is per-surface) is related to selecting checks; this entry covers the tool permission failure that prevented checks from starting."
area: "validation and tool-failure recovery"
date: 2026-09-25
session_context: "The implementation was complete enough for focused tests and typecheck, but three independent PowerShell validation calls were denied before any command ran."
parked_until:
resolved:
resolution:
reference: "Session validation calls for tests/searchableSelect.test.ts, npm run typecheck, and tests/dashboardDateRange.test.ts"
---

**Issue:** Three independent validation commands were denied by the command tool before execution. The failure was discovered after implementation and could otherwise be mistaken for test results or silently bypassed.

**Improvement:** Flush the observation immediately, retry once through the same interface, then use an alternate execution path or report validation as blocked. Never claim tests passed when the command did not start.

**Principle:** A validation tool failure is evidence about the validation process, not about the code; preserve it before attempting recovery so the session cannot end with an unverified success claim.
