---
id: 13
title: "A safety-net pass must reuse the primary eligibility gate"
status: open
type: open-source
skill: []
proposes_skill: []
siblings_checked: "none: no skill family registry; instance is pipeline/FK but the principle is gate reuse"
area: "pipeline: backfill / ensure-* after a filtered pass"
date: 2026-09-15
session_context: "CSV ingest FK: candidate_applications upsert for AWL-39218 with no profiles row"
parked_until:
resolved:
resolution:
reference:
---

**Issue:** Phase C dropped candidates with no `profiles` row (or not Zoho-connected). A later `ensureApplicationRowsFromCsv` pass re-read the raw CSV with `syncProfiles: false` and upserted child rows for every ID, violating `candidate_applications_applywizz_id_fkey`.

**Suggested improvement:** Any backfill or safety-net that re-processes the original input must apply the same parent-existence / eligibility checks as the first pass. Do not treat "write the child rows again" as ungated.

**Principle:** A second pass over the same source that skips the first pass's gate is not a safety net — it is an invariant bypass.
