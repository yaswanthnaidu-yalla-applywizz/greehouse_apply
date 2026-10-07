---
id: 28
title: "A storage credential probe must not replace the shared database client"
status: open
type: open-source
skill: []
proposes_skill: []
siblings_checked: "0006 covers diagnosing ambiguous empty Storage listings and validating key identity; this is distinct: a successful Storage probe must not mutate the process-wide DB client's authorization context."
area: "Supabase client lifetime and CSV storage discovery"
date: 2026-10-07
session_context: "Production logs showed canonical stats reads behaving as if RLS hid the config row and audit inserts rejected by RLS, although startup and SQL verified service_role. CSV discovery could replace the shared DB singleton with the first key that listed a pending file."
parked_until:
resolved:
resolution:
reference: "src/scanner/storageCsvIngestion.ts; src/db/client.ts"
---

**Issue:** A storage-discovery probe used one candidate key to list pending CSVs, then replaced the process-wide Supabase client with that candidate. Because the anon key is tried first and may have Storage access, subsequent unrelated database reads and writes could run under anon and fail RLS checks.

**Suggested improvement:** Keep the application database client bound to the configured service-role credential. Use candidate-specific clients only for Storage discovery and operations that explicitly need them; do not promote a client based on success against a different service.

**Principle:** A credential authorized for one service or operation must not silently become the process-wide identity for unrelated database operations.
