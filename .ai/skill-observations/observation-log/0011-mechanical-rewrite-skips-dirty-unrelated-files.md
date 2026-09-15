---
id: 11
title: "A repo-wide mechanical rewrite must skip files whose dirty diff is not from this task"
status: open
type: open-source
skill: []
proposes_skill: []
siblings_checked: "none: no skill family"
area: "bulk search-replace across a working tree that other sessions also have open"
date: 2026-09-15
session_context: "Replacing console.* with a central logger across src/; manager.ts already had an incomplete role-scoping refactor"
parked_until:
resolved:
resolution:
reference:
---

**Issue:** A scripted replace of `console.log/warn/error` across `src/` also landed on `manager.ts`, which already had uncommitted, unrelated edits (admin vs manager gating). Those edits had deleted `const isAdmin` but left a use of `isAdmin`, so typecheck failed for reasons that had nothing to do with the logger. Restoring the file from HEAD and re-applying only the logger lines unblocked the chore.

**Suggested improvement:** Before a repo-wide mechanical edit, list files that already have a dirty diff. Patch those by hand (or restore + re-apply only the task's lines). Do not let a bulk rewriter finish someone else's half-change.

**Principle:** A working tree is not a clean checkout. A mechanical rewrite that does not first isolate files with unrelated dirty diffs will splice into in-flight work and report that work's breakage as its own.
