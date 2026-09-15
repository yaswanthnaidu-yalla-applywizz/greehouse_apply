---
id: 14
title: "A TypeScript row field is not a database column until a migration lands"
status: actioned
type: open-source
skill: []
proposes_skill: []
siblings_checked: "none: no skill family registry; instance is profiles.country but the rule is schema/type lockstep"
area: "DB row types vs SQL schema / migrations"
date: 2026-09-15
session_context: "Railway ingest skipped every new ApplyWizz profile: upsertProfile wrote country/country_code that profiles never had"
parked_until:
resolved: 2026-09-15
resolution: "Migration 016 (profiles.country + country_code); upsertProfile and profile patches retry by stripping any column PostgREST reports missing from the profiles schema cache; schema.sql updated."
reference: "greenhouse_logs_2026-09-15.md"
---

**Issue:** `ProfileRow` and `upsertProfile` included `country` and `country_code`, and ingest treated a successful ApplyWizz fetch as enough to create the parent row. The live `profiles` table, `schema.sql`, and migrations 001–015 never added those columns. PostgREST rejected every upsert (`Could not find the 'country' column of 'profiles' in the schema cache`). The write path swallowed the error, wrote a local JSON cache, and returned the in-memory payload, so the failure only showed up later as `ApplyWizz profile was not written to Supabase profiles`. Existing rows kept working because they already existed; only creates were blocked.

**Suggested improvement:** When a field is added to a DB-mapped TypeScript row type, add the column to `schema.sql` and a numbered migration in the same change. Treat "the type compiles" as insufficient. If an upsert is required for a later FK, do not swallow the Supabase error and pretend local cache is success.

**Principle:** A typed field on a persistence object is a claim about the live schema. If the migration is not in the same change, the first production write of a new row is the test — and it fails closed on create, not on update.
