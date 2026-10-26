---
id: 28
title: "A storage credential probe must not replace the shared database client"
status: actioned
type: open-source
skill: []
proposes_skill: []
siblings_checked: "0006 covers diagnosing ambiguous empty Storage listings and validating key identity; this is distinct: a successful Storage probe or auth OTP verification must not mutate the process-wide DB client's authorization context."
area: "Supabase client lifetime and auth verification"
date: 2026-10-07
parked_until:
resolved: 2026-10-12
resolution: "Created createEphemeralAuthClient() in src/server/routes/auth.ts for verifyOtp, ensuring getDbClient() singleton remains bound to service_role and is never mutated by user session tokens."
reference: "src/scanner/storageCsvIngestion.ts; src/db/client.ts; src/server/routes/auth.ts"
---

**Issue:** A storage-discovery probe or user auth OTP verification (`supabase.auth.verifyOtp`) mutated the process-wide Supabase client (`getDbClient()`). Calling `verifyOtp` on the singleton set an `authenticated` user session on the client, causing subsequent service_role DB reads/writes (`gh_audit_events`, `gh_stats_config`) to fail or return empty due to RLS.

**Suggested improvement:** Keep the application database client bound to the configured service-role credential. Use candidate-specific or ephemeral clients only for user authentication and Storage discovery; never call session-mutating auth methods on the shared database singleton.

**Principle:** A credential authorized for one service or operation must not silently become the process-wide identity for unrelated database operations.
