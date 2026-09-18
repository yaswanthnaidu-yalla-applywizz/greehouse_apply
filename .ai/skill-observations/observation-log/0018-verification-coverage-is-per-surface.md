---
id: 18
title: "Verification coverage is per-surface: the same defect is a build error in one tree and invisible in the other"
status: open
type: open-source
skill: []
proposes_skill: []
siblings_checked: "0016 (token presence is not shape) is adjacent but distinct: there a check ran and passed while the structure was wrong; here no check runs at all because the surface has no compiler. 0015 is about tooling blocking reads, not about absent verification."
area: "choosing verification per file type in a mixed-toolchain codebase"
date: 2026-09-18
session_context: "Edited dashboard/public/manager.html (browser-Babel JSX, no compile step) immediately after a tsc-checked src/ edit in the same session; a wrong identifier on the HTML surface has no static check to fail"
parked_until:
resolved:
resolution:
reference: "dashboard/public/manager.html and src/db/applications.ts (both edited 2026-09-18); dashboard/tsconfig.json covers *.tsx only"
---

**Issue:** In one session two edits were made to two dashboard surfaces. The first was in `src/`, covered by `tsc --noEmit` — a wrong call form there was caught in seconds by the compiler. The second was in `dashboard/public/manager.html`, which is JSX compiled in the browser by Babel standalone off a CDN: no compile step in the repo, no lint config at the root, no test touching it. The same class of mistake — an identifier that does not exist in scope — is a hard build failure on one surface and a silent runtime failure on the other, and nothing in the toolchain announces the difference: both artifacts are "the manager dashboard", one is typed and checked, the other is not, and the extension is the only hint. The repo does have `tsc -p dashboard` as `typecheck:dashboard`, but it covers the `.tsx` mirror, not `dashboard/public/*.html` — so "the dashboard typechecks" is true while the file actually served to users is unchecked.

**Suggested improvement:** Before editing, establish which checks actually cover the target file — a compile step, a typecheck project, a lint config, a test — and where there are none, compose by hand what the compiler would have contributed: resolve every identifier the change references against the file's real scope, confirm the construct exists where it is being used, and re-read the edited region after writing. On an unchecked surface, prefer the form of the change that is already present and working elsewhere in the same file, since an identical statement that ships today cannot be syntactically new.

**Principle:** The cost of a defect is set by the surface's verification coverage, not by the size or apparent triviality of the change. In a mixed-toolchain codebase the same mistake is a two-second build error in one directory and a silent runtime failure in another, and the surface with no compiler is precisely where "verify at the end" has nothing to invoke. Uniform-looking artifacts with non-uniform toolchains invert the usual instinct — the trivial-looking file is the one where verification must be built by hand at the point of the edit, because the free checks that make trivial edits safe simply are not there.
