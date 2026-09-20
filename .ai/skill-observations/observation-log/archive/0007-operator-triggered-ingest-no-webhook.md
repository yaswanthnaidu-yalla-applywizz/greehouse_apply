---
id: 7
title: "CSV upload to Storage does not auto-start pipeline without explicit trigger"
status: actioned
type: open-source
skill: []
proposes_skill: []
siblings_checked: "none: no skill family"
area: "ingest:storage / admin API"
date: 2026-09-15
session_context: "Debug why csv_uploads upload did not run pipeline on Railway"
parked_until:
resolved: 2026-09-15
resolution: "Shipped admin Start button (202), ingest-status polling, documented operator-driven model in techContext/systemPatterns. Root cause was missing trigger not dead daemon."
reference: "commit 8c30ef4, .ai/techContext.md CSV Ingestion Trigger section"
---

**Issue:** No webhook, Realtime listener, poller, or DB trigger on storage.objects. Only one-shot CLI and unused admin POST. Railway single service runs server only; queue worker unrelated to ingest.

**Suggested improvement:** Operator-triggered 202 + status endpoint; admin-only dashboard button; do not assume Storage upload implies pipeline start.

**Principle:** Event-driven ingest needs an explicit, authenticated trigger in the architecture doc — absence of a listener is indistinguishable from \"broken ingest\" to operators uploading files.
