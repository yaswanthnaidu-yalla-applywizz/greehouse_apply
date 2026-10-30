---
title: "Audit queries must chunk large membership filters"
date: 2026-10-30
status: open
skill: "systematic-debugging"
proposes_skill: ""
type: internal
severity: medium
siblings_checked: "checked — instance-specific, no propagation"
session_context: "2026-10-30 operator approval and choice metadata implementation"
---

## Issue

The first read-only choice-metadata audit used one large PostgREST `in(job_url, ...)` filter. The request failed with an unhelpful `[object Object]` error when the URL list was large enough.

## Improvement

Chunk large membership filters before querying PostgREST, and keep the audit read-only. The chunked audit completed and returned six concrete bad metadata rows.

## Principle

Diagnostic tooling must exercise the same request-size limits as production paths and report bounded, actionable results rather than collapsing a transport failure into an empty or opaque result.
