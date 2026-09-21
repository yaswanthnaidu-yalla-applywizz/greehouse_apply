---
id: 23
title: "Service env var drift: INGEST_ONLY=true on primary web service disables route registration and causes Cannot GET / 404"
status: actioned
type: open-source
skill: []
proposes_skill: []
siblings_checked: "none: no existing observation covers multi-service env var misconfiguration or mode-based route suppression"
area: "deployment topology and environment configuration"
date: 2026-09-21
session_context: "gh.applywizz.ai returned 404 'Cannot GET /' after deployment because greehouse_apply service had INGEST_ONLY=true configured in Railway"
parked_until:
resolved: 2026-09-21
resolution: "Deleted INGEST_ONLY from greehouse_apply service on Railway and set ALLOWED_ORIGINS; verified greehouse_apply boots full REST API + TSX dashboard"
reference: "Railway project secure-alignment service greehouse_apply"
---

**Issue:** Visiting the primary web domain (`gh.applywizz.ai`) returned an Express default 404 (`<pre>Cannot GET /</pre>`). Investigation of Railway environment variables revealed that `INGEST_ONLY: true` was set on the primary web service `greehouse_apply` (a configuration intended only for the dedicated `injest` service). In `src/server/index.ts`, `isIngestOnly` returns early after registering only 4 internal ingest endpoints, skipping all dashboard HTML, static asset, and user-facing API route registrations.

**Suggested improvement:** Ensure service-specific mode flags (`INGEST_ONLY`, `ENABLE_QUEUE_WORKER`) are audited per service in multi-service project setups. Also ensure `ALLOWED_ORIGINS` is configured on the primary web service for CORS policy compliance.

**Principle:** When an application uses mode-based early returns to conditionally mount subsets of routes, verify that the routing mode environment variables on the public-facing service match its intended role, rather than inheriting flags from background or ingest workers.
