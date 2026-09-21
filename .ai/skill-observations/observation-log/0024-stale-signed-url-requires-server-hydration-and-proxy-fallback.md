---
id: 24
title: "Expiring asset URLs in persistent DB records must be rehydrated on read and backed by a server proxy endpoint"
status: actioned
type: open-source
skill: []
proposes_skill: []
siblings_checked: "Checked 0020 (endpoint missing fields client-side); this observation focuses on time-decay of credentials/signed URLs stored in DB records and avoiding client-side retry loops when CORS or strict ID validation rejects the renewal."
area: "storage asset lifecycle, signed URL expiration, and resilient UI media viewers"
date: 2026-09-21
session_context: "Operator dashboard View Web Proof failing to render expired signed URLs and infinite retry looping on ProofViewer"
parked_until:
resolved: 2026-09-21
resolution: "Actioned: Added hydrateApplicationProofUrls() to candidate job endpoint, added dual UUID/ApplyWizzId lookup to proof-url, added /proof-image direct streaming proxy route, and equipped ProofViewer with multi-stage fallback (initial -> signed URL -> proxy stream)."
reference: "src/server/index.ts GET /api/candidates/:applywizzId/jobs/*; src/server/routes/submissions.ts GET /:id/proof-url and /:id/proof-image; dashboard/components/ProofViewer.tsx"
---

**Issue:** Confirmation screenshots were uploaded to private cloud storage buckets with signed URLs valid for 24 hours and written into database records. When operators viewed submissions older than 24 hours, the signed URLs returned HTTP 403. The UI viewer fell back to a re-fetch endpoint, but the invocation omitted the application UUID and passed a candidate identifier instead. The backend rejected non-UUIDs with HTTP 400, causing the viewer to show an error and prompt "Retry", which entered an infinite loop repeatedly querying the failing endpoint.

**Suggested improvement:** 
1. Re-hydrate time-decaying signed URLs at read-time in all backend endpoints returning application rows.
2. Ensure asset URL renewal endpoints accept all canonical identity representations (UUID, candidate ID + job URL composite key).
3. Back direct-to-storage signed URLs with a first-party server streaming proxy endpoint to eliminate client CORS and token expiration failures entirely.
4. Build viewer components with progressive fallback (current URL -> freshly fetched signed URL -> backend streaming proxy) rather than a single repeating retry loop.

**Principle:** Time-decaying access tokens or signed URLs stored in persistent records will inevitably expire. Relying exclusively on client-side direct CDN access creates fragile failure modes when tokens expire or CORS policies change. Endpoints serving persistent records must re-hydrate tokens on read, and UI asset viewers must have a server-side streaming proxy fallback.
