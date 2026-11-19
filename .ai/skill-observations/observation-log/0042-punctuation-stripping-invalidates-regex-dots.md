---
id: 42
title: "Punctuation stripping in normalization invalidates dot-dependent choice aliases"
status: actioned
type: internal
skill: [choiceOptions]
proposes_skill: []
siblings_checked: "none"
area: "utils/choiceOptions"
date: 2026-11-13
session_context: "greenhouse 376 failures root cause investigation"
parked_until:
resolved: 2026-11-13
resolution: "Actioned: updated degree alias regexes to match whitespace instead of literal dots (b\\s*tech, b\\s*s, m\\s*s, ph\\s*d)"
reference: "src/utils/choiceOptions.ts"
---

**Issue:** `normalize()` converts all non-alphanumeric characters to spaces (`.replace(/[^a-z0-9]+/g, ' ')`). Downstream alias regexes in `canonicalAlias` tested for literal dots like `b\\.tech`, `b\\.s\\.`, and `m\\.s\\.`. Because the normalized string never contained dots, these regexes never matched, causing candidates with B.Tech, B.S., and M.S. to fail degree matching and wipe out to blank values.

**Suggested improvement:** Always construct regexes in alias matchers to expect whitespace (`\\s*`) rather than literal punctuation (`\\.`) after a string has passed through punctuation-stripping normalization.

**Principle:** When an input pipeline strips or replaces punctuation before normalization, downstream matchers must match the normalized representation rather than the raw token format.
