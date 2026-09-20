---
id: 4
title: "Fixing a class of defects in unchecked code is half the work; the missing check is the cause"
status: actioned
type: open-source
skill: []
proposes_skill: []
siblings_checked: "none: no skill family"
area: "completing cleanup tasks; pairing a fix with the enforcement that keeps it fixed"
date: 2026-09-15
session_context: "Fixing 35 accumulated type errors in a dashboard source tree that no tsconfig covered"
parked_until:
resolved: 2026-09-15
resolution: "dashboard/tsconfig.json + npm run typecheck chained to typecheck:dashboard; positive control verified (deliberate .tsx break exits 2). Enforcement shipped with the cleanup, not after."
reference:
---

**Issue:** A source tree had accumulated 35 type errors, including one that would have thrown on first mount. The request was to fix them, and fixing them was straightforward: the 35 errors reduced to four root causes, and the tree went clean. But the reason 35 had accumulated at all was that nothing typechecked the directory — it was outside the project's `tsconfig` include and had no build step. Had the task ended at "all 35 fixed", the work would have measured as complete while restoring exactly the state that produced the errors, and the count would climb again invisibly. The fix and the reason the fix was needed were separate problems, and only the first was named in the request.

**Suggested improvement:** When a task is to clear an accumulated backlog of defects that an automated check would have caught, treat "why did no check catch these" as part of the task, and propose the enforcement alongside the fix rather than after it. Then verify the enforcement can fail: run a deliberate violation through it and confirm it reports, then remove it and confirm it passes. An added check that silently passes everything is indistinguishable from a working one, and it is most likely to be wrong precisely when it is added at the end of a long task.

**Principle:** Accumulated defects of one kind in one place are evidence about a missing check, not just about the code. The count is a symptom; the absence of enforcement is the cause, and repairing only the symptom returns the system to the state that generated it while producing the visible artefact of completion. So a cleanup is finished when a new instance of the same defect would be caught, not when the current instances are gone — and that claim needs a positive control, because a check bolted on at the end of a task is both the least tested thing in the change and the only thing standing between the cleanup and a silent repeat.
