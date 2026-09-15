---
id: 6
title: "Supabase Storage listBuckets empty with no error masks wrong service key"
status: actioned
type: open-source
skill: []
proposes_skill: []
siblings_checked: "none: no skill family"
area: "CSV ingest from Supabase Storage / Railway env"
date: 2026-09-15
session_context: "Admin Start button for csv_uploads ingest; Railway reported visible buckets none despite CSV present; env allegedly set"
parked_until:
resolved: 2026-09-15
resolution: "Added src/db/supabaseKeyDiagnostics.ts (JWT role/ref vs URL, whitespace flag); ingest logs Credential identity and bucket-missing hints; getDbClient trims URL/key. Uncommitted with rest of session work."
reference: ".ai/progress.md (Known Bugs), src/scanner/storageCsvIngestion.ts"
---

**Issue:** With a non-service_role Supabase key (or URL/ref mismatch), `storage.listBuckets()` and `from(bucket).list()` can return empty arrays with **no error**. Ingest reported success with zero pending files; `ensureBucketsExist()` attempted `createBucket` and logged RLS violations. Operators believed env was correct because variables existed. Code only reads `SUPABASE_SERVICE_KEY`, not `SUPABASE_SERVICE_ROLE_KEY`.

**Suggested improvement:** Before trusting empty storage lists: assert bucket visibility, decode JWT `role`/`ref` vs URL (log summary, never secret), trim keys on client init, map failures to `ingestRun.error` in UI. Document env name and service_role requirement in techContext.

**Principle:** For privileged cloud APIs where empty results are ambiguous, treat \"empty + no error\" as a credential diagnostic signal — log identity claims (role, project ref, match) before concluding \"nothing to do.\"
