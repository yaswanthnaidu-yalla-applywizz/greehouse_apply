---
id: 31
title: "Form validation failure misdiagnosed as confirmation timeout"
status: actioned
type: open-source
skill: [playwright-submitter]
proposes_skill: []
siblings_checked: "none"
area: "submitter / confirmation verification and error handling"
date: 2026-10-08
session_context: "diagnosing submit confirmation timeouts on modern Greenhouse job boards"
parked_until: ""
resolved: 2026-10-08
resolution: "Reverted speculative timeout/challenge logic; identified root cause as unselected phone country dropdown"
reference: ""
---

**Issue:** Forms with unselected phone country dropdowns (`#country`) blocked submission upon clicking the submit button with inline validation ("Select a country"). Instead of checking for inline DOM validation errors, the submitter waited for confirmation tokens until timing out at 60 seconds, misclassifying ordinary form-filling defects as confirmation timeouts or challenge blocks.

**Suggested improvement:** Inspect post-submit DOM validation errors (`.field-error`, invalid inputs, required indicators) immediately (within 2 seconds) after clicking submit. Fail immediately with form validation detail rather than stalling for confirmation tokens.

**Principle:** Before concluding an operation timed out waiting for an external system, verify whether local validation or precondition checks rejected the action immediately.
