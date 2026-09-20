---
id: 1
title: "Demo job queue must merge Supabase with fixtures; Greenhouse selects are comboboxes"
status: actioned
type: internal
skill: []
proposes_skill: []
siblings_checked: "none: no skill family"
area: "operator dashboard + form submission"
date: 2026-09-15
session_context: "Session fixes for AWL-31428 queue (1 vs 4 jobs) and sponsorship remix-css select fill"
parked_until:
resolved: 2026-09-15
resolution: "Documented combobox + demo merge in .ai/systemPatterns.md and progress.md; formFiller sponsorship path hardened (commits 17b4ee5, 851db48)."
reference:
---

**Issue:** `GET /api/candidates/:id/jobs` returned only Supabase rows when any row existed, hiding bundled demo jobs. Separately, form filler assumed native `<select>` for sponsorship questions on modern Greenhouse boards (`select_input-container`, `role="combobox"`).

**Suggested improvement:** Document in `.ai/systemPatterns.md` Submission Flow: (1) pinned demo IDs merge DB + artifacts by URL; (2) select-type fields may require searchable combobox fill path. Add regression tests when changing either path.

**Principle:** When Supabase is configured, "DB has rows" does not mean "DB has the full intended queue" for demo or partial-ingest candidates — merge by job URL with artifact/segment fallbacks for known pinned IDs.
