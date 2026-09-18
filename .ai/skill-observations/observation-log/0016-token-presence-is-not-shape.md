---
id: 16
title: "A structural defect survives every symbol-level check a spec asks for"
status: open
type: open-source
skill: []
proposes_skill: []
siblings_checked: "none: verification-method finding, not a tool- or subject-specific skill family"
area: "verifying a delivered feature against its written spec"
date: 2026-09-17
session_context: "Audited a 7-item dashboard stats spec (submitted_today, role-scoped, four panels) against a React/JSX dashboard after commit ae4946b shipped it"
parked_until:
resolved:
resolution:
reference:
---

**Issue:** All seven items of the spec were present by token and correctly wired: the six-status list, `updated_at >=` start of today IST, the per-role scoping, the manager per-operator column, the admin and dev totals, and the poll. But the new operator card was inserted *before* the closing tag of the "Total Candidates" card, so it renders as a card nested inside another card, and that card's caption (`Ingested & segregated`) is left dangling below the nested block. Every string a checklist would search for exists, in the right file, bound to the right field. Only the DOM shape is wrong. A second deviation ran the other way: the operator poll is 3000 ms where the spec asked for 30000 ms — a check phrased as "is it polled?" passes, and the deviation is *fresher* than specified, so it never surfaces as a bug report.

**Suggested improvement:** When checking delivered UI against a spec, read the surrounding block, not the matching line: sibling structure and closing tags are exactly what a symbol search cannot see. Assert placement — is the element a child of the grid or a descendant of an unrelated card? — and compare every numeric constant the spec names against the code in both directions, since a value that differs by being larger or more frequent is invisible to a regression test.

**Principle:** A spec's acceptance criteria are typically expressed as tokens (a field name, a column header, a status list), and tokens are layout-blind. Passing them proves presence, not shape, and the failure they miss is the one introduced by insertion: the code that is new lands in the right file and the wrong place. Verification worth trusting has to inspect the container, not the contents.
