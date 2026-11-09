---
id: 41
title: "FADA reads stale requiredness property"
status: open
type: project
skill: [fada]
proposes_skill: []
target_file: [.agents/skills/fada/scripts/fada-engine.ts]
siblings_checked: "FADA engine and current production resolved_fields payloads inspected"
area: "Filter diagnostic required/optional classification"
date: 2026-11-09
session_context: "The November 8-9 FADA run reported zero required unresolved fields because it reads f.required, while all inspected production fields use f.isRequired."
parked_until:
resolved:
resolution:
reference: ".ai/diagnostics/fada-report-2026-11-08-to-09.md"
commands_verified: "Read-only DB2 audit: 10,592 truly optional unresolved fields; 626 required empty/unresolved fields"
---

**Issue:** The FADA filter report treats every unresolved field as optional when the old `required` property is absent. This hides required-field backlog and can lead to incorrect resolver-policy conclusions.

**Suggested improvement:** Read `isRequired` first, retain `required` only as a backward-compatible fallback, and add a fixture using each schema shape.

**Principle:** Diagnostics must validate their schema contract before aggregating safety-significant classifications.
