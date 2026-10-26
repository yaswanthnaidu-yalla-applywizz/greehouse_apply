---
id: 27
title: "Zero-context partial staging can place insertions in the wrong code block"
status: actioned
type: open-source
skill: task-observer
proposes_skill: []
siblings_checked: "0011 covers avoiding unrelated dirty-file changes; this observation concerns syntactic placement during partial staging."
area: "Git patch staging"
date: 2026-10-07
session_context: "While separating sandbox hunks from a mixed server file, a zero-context cached patch applied insertions at incorrect locations and left a committed intermediate revision with malformed route registration."
parked_until:
resolved: 2026-10-07
resolution: "Re-staged the complete server file from the intended working tree, inspected the committed source, and verified typecheck and build before pushing."
reference: "src/server/index.ts; commit d1ca031"
---

**Issue:** A hand-built `git apply --cached --unidiff-zero` patch selected only some mixed-file hunks but lacked enough surrounding context to preserve their syntactic location. Inserted route code landed inside a CORS options block.

**Improvement:** Avoid context-free partial staging for structural code. Prefer `git add -p` with inspected prompts, or stage the complete related file; inspect the staged/committed file around every insertion and run the build before pushing.

**Principle:** A hunk can apply cleanly by line position yet still be syntactically misplaced; validate staged structure, not only patch application success.
