---
id: 36
title: "Distinguish neighboring counters before diagnosing a low number"
status: open
type: open-source
skill: [principle-explain-the-number]
proposes_skill: []
siblings_checked: "no family registry in this project anchor; available measurement and verification principles checked, this applies specifically to number interpretation"
area: "Counter semantics before root-cause analysis"
date: 2026-10-29
session_context: "Railway autoqueue diagnostics initially treated autoqueued counts as fully resolved counts until the user corrected the metric"
parked_until:
resolved:
resolution:
reference: "docs/fkedup.md"
---

**Issue:** The diagnosis explained why 420 and 554 applications were autoqueued without first checking whether those numbers represented fully resolved applications. Railway logs contained separate fully-resolved and autoqueued counters with different definitions.

**Suggested improvement:** Add a rule to Explain the Number requiring the agent to name the counter's producer, definition, numerator, and denominator, then compare it with adjacent counters before explaining a gap.

**Principle:** Similar-looking counters in one pipeline are not interchangeable. Establish each counter's exact state transition and inclusion rules before attributing causes.
