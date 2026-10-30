---
id: 37
title: "Immutable field guards need type-aware blankness and provenance"
status: actioned
type: open-source
skill: [blast-radius, principle-model-domain]
proposes_skill: []
siblings_checked: "blast-radius and domain-modeling guidance checked; neither explicitly requires auditing defaults and invented fallbacks before defining populated state"
area: "State authority and overwrite protection"
date: 2026-10-29
session_context: "Blast-radius analysis for making profiles identity/contact facts immutable after first population"
parked_until:
resolved: 2026-10-29
resolution: "Shipped migration 043_protect_profile_facts.sql to DB1 and DB2 with BEFORE UPDATE trigger, trusted override session setting (app.profile_authoritative_override), and audit trail in gh_audit_events; isolated E2E test suite fixture from real candidates; backfilled and synchronized profiles across both DBs."
reference: "scripts/proveProfileAuthorityGuard.ts"
---

**Issue:** A null-only profile guard would treat PostgreSQL defaults (`false`, `[]`) and parser fallbacks (`US Citizen`, `false`) as authoritative facts. That can freeze invented values and block later correct data. Text, booleans, and JSON arrays have different definitions of blank, and some values need source provenance to distinguish missing from deliberately false.

**Suggested improvement:** Add a blast-radius check for any "immutable once populated" policy: inventory column defaults, parser fallbacks, coercions, and sentinel values; define populated state per type; and prove both blank-fill and overwrite-block behavior before recommending the guard.

**Principle:** Immutability is safe only when the system can distinguish a real value from a default that represents missing data.
