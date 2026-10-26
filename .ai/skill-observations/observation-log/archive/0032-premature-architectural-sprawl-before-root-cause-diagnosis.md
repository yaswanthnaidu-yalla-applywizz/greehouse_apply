---
id: 32
title: "Premature architectural sprawl before root-cause diagnosis"
status: actioned
type: open-source
skill: [architecture, debugging]
proposes_skill: []
siblings_checked: "none"
area: "debugging methodology / change discipline"
date: 2026-10-08
session_context: "post-mortem of drop in success rates and rollback of migrations 029-031"
parked_until: ""
resolved: 2026-10-08
resolution: "Rolled back migrations 029-031 and reverted working tree changes to clean baseline commit 7a35135"
reference: ""
---

**Issue:** Multiple layers of failure diagnostic tables, status retry columns, migrations, and lock systems were added to diagnose submission drop-offs, when the root causes were simple DOM filling errors (unselected `#country` dropdown) and an inverted location resolver fallback introduced earlier that day. This created architectural noise and migration sprawl without addressing the actual problem.

**Suggested improvement:** When a previously working pipeline degrades after recent modifications, isolate recent diffs first and check ground-truth visual artifacts (e.g. failure screenshots) before introducing new database schemas, migrations, or orchestration subsystems.

**Principle:** When diagnosing system regressions, check recent behavioral changes and ground-truth artifacts before building diagnostic infrastructure.
