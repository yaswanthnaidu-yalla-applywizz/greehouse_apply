---
id: 29
title: "Patch context copied from redacted tool output may not match the source file"
status: open
type: internal
skill: []
proposes_skill: []
siblings_checked: "no applicable skill family: this concerns environment-level file rendering, not a specific skill"
area: "Editing against file contents displayed with automatic redaction"
date: 2026-10-08
session_context: "Continuing the failure-diagnostics implementation"
parked_until:
resolved:
resolution:
reference: "tests/failureDiagnostics.test.ts"
---

**Issue:** A file view masked a bearer-token fixture as `******`, but patch matching used the unmasked bytes from the source and failed when the visible redaction was used as context. The focused test confirmed the stored fixture exercised the sanitizer despite its masked display.

**Suggested improvement:** When a literal patch fails against apparently matching sanitized output, use a nearby non-sensitive anchor and verify the behavior with a focused test rather than repeatedly copying the masked text into the patch.

**Principle:** Tool-rendered file output may not be a byte-faithful patch context when automatic secret redaction is active.
