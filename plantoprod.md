# Plan to Prod — Operator Queue Triage + CA Notification
_Sprint: 8 hrs | Last updated: 2026-10-07_

---

## Interview Answers (Locked Requirements)

| # | Question | Answer |
|---|---|---|
| 1 | What sources count as "safe" for auto-queue? | `supabase` only (Tiers 1–4). `ai` on any required field = operator queue. |
| 2 | Required fields fully `unresolved` — operator queue or different? | Operator queue (same treatment as AI-answered). |
| 3 | Optional fields answered by AI — block auto-queue? | No. Only required fields matter. |
| 4 | Notification email timing | Once per ingest run, after full pipeline finishes. |
| 5 | Email format + content | HTML, summary counts per CA, link to gh.applywizz.ai at bottom. |
| 6 | Email sender | Existing Azure/MS365 noreply (same one used for OTP). |

---

## Feature 1 & 2 — Auto-Queue Routing + Operator Queue Filter

### Logic (at resolve time, inside `answerResolver.ts` / `upsertApplication`)

After resolution, before upsert:

```
requiredFields = resolvedFields.filter(f => f.isRequired)
needsReview = requiredFields.some(f => f.source === 'ai' || f.source === 'unresolved')

if needsReview  → status = READY_FOR_REVIEW   (operator sees it)
else            → status = QUEUED             (auto-queued, operator never sees it)
```

### Files to change

| File | Change |
|---|---|
| `src/resolver/answerResolver.ts` | Compute `needsReview` flag post-resolve; pass to upsert |
| `src/db/applications.ts` → `upsertApplication` | Accept `autoQueue: boolean`; set initial status to `QUEUED` when `true`, else `READY_FOR_REVIEW` |
| `src/db/applications.ts` → `getApplicationsForOperator` / candidate jobs list | Add filter: only return rows where `status = READY_FOR_REVIEW` OR (`status != QUEUED` AND has AI/unresolved required field) |

### Dashboard filter (Feature 2)

Operator queue already reads `READY_FOR_REVIEW` rows. Since auto-queued apps skip that status entirely, no dashboard code needs to change — they simply never appear. Confirm this assumption: if any existing query returns `QUEUED` rows to the operator list, add exclusion there.

### Edge cases

- SKIPPED (over-cap) — unchanged, never auto-queued.
- Application already exists (re-ingest) — `upsertApplication` preserves existing non-empty `resolved_fields`; re-evaluate `needsReview` against the merged fields before deciding status. Don't downgrade `APPLIED` / `FAILED` / in-flight statuses.
- All required fields optional (job has no required fields) → `needsReview = false` → auto-queue.

---

## Feature 3 — Post-Ingest CA Notification Email

### Trigger point

`src/orchestrator/pipeline.ts` — end of Phase D (resolution complete), before pipeline exits.

### Logic

```
1. Query gh_candidate_applications WHERE status = READY_FOR_REVIEW
   AND created_at >= ingest run startedAt   ← scope to this run only
2. Group by assigned_ca_email
3. For each CA email:
   - caEmail, clientCount (distinct applywizz_id), appCount (total rows)
4. Send one HTML email per CA via existing Azure sendEmail util
```

### Email template

```html
Subject: You have new applications to review — ApplyWizz

<h2>Hi,</h2>
<p>
  You have <strong>{appCount} application(s)</strong> across
  <strong>{clientCount} client(s)</strong> that need your review.
  These applications have questions answered by AI or left unresolved
  and require operator approval before submission.
</p>
<p>
  <a href="https://gh.applywizz.ai">Open ApplyWizz Dashboard →</a>
</p>
<p style="color:#888;font-size:12px;">
  This is an automated message from ApplyWizz. Do not reply.
</p>
```

### Files to change

| File | Change |
|---|---|
| `src/services/caNotificationEmail.ts` | New file. Query + group logic + call `sendEmail` |
| `src/orchestrator/pipeline.ts` | Call `sendCaNotificationEmails(runStartedAt)` at end of Phase D |
| `src/services/azureEmail.ts` | Verify `sendEmail(to, subject, htmlBody)` signature — reuse as-is |

### Error handling

- Single CA email failure → log WARN, continue. Don't fail the ingest.
- No READY_FOR_REVIEW rows → skip silently.
- `assigned_ca_email` is null → skip that group.

---

## Execution Order

```
[STEP 1] Feature 1 core logic — needsReview flag + upsert status routing
[STEP 2] Regression: re-ingest idempotency, SKIPPED passthrough, all-optional jobs
[STEP 3] Feature 2 verification — confirm QUEUED rows don't appear in operator queue
[STEP 4] Feature 3 — caNotificationEmail.ts + pipeline hook
[STEP 5] Test email locally (sandbox CA email override env var or hardcoded test address)
[STEP 6] typecheck + build
[STEP 7] Deploy to Railway
```

---

## agy Prompts

### Step 1 — Plan

> @AGENTS.md @.ai/systemPatterns.md @.ai/activeContext.md @.ai/techContext.md
>
> Plan only. Do not write code yet.
>
> We are adding auto-queue routing to the resolve step and a post-ingest CA notification email.
>
> **Feature 1 & 2 — Auto-queue routing:**
> After resolution, before upsert in `answerResolver.ts` + `upsertApplication` in `src/db/applications.ts`:
> - Compute `needsReview = resolvedFields.filter(f => f.isRequired).some(f => f.source === 'ai' || f.source === 'unresolved')`
> - If `needsReview === false` → initial status = `QUEUED` (skip READY_FOR_REVIEW entirely)
> - If `needsReview === true` → initial status = `READY_FOR_REVIEW` (operator reviews)
> - Never downgrade in-flight or terminal statuses on re-ingest
> - SKIPPED logic unchanged
>
> **Feature 3 — Post-ingest CA notification email:**
> - New file `src/services/caNotificationEmail.ts`
> - After Phase D in `src/orchestrator/pipeline.ts`, query `gh_candidate_applications` WHERE `status = READY_FOR_REVIEW` AND `created_at >= runStartedAt`, group by `assigned_ca_email`, send one HTML email per CA using existing `azureEmail.ts` with subject "You have new applications to review — ApplyWizz", summary counts, and link to gh.applywizz.ai
> - Single CA failure = WARN + continue
>
> Identify every file that needs to change. Flag any schema change needed. Flag any risk to idempotent re-ingest or existing submission flow.

---

### Step 2 — Implement

> @AGENTS.md @.ai/systemPatterns.md @.ai/activeContext.md @.ai/techContext.md
>
> Implement the plan from the previous step. Surgical changes only.
>
> 1. `src/resolver/answerResolver.ts` — after building `resolvedFields`, compute `needsReview` and pass `autoQueue: !needsReview` to `upsertApplication`
> 2. `src/db/applications.ts` → `upsertApplication` — accept `autoQueue` param; set initial status `QUEUED` when true and current status is not already in-flight or terminal; otherwise `READY_FOR_REVIEW`
> 3. `src/services/caNotificationEmail.ts` — new file with `sendCaNotificationEmails(runStartedAt: Date)` using existing `azureEmail.ts`
> 4. `src/orchestrator/pipeline.ts` — call `sendCaNotificationEmails(startedAt)` at end of Phase D
>
> No schema migrations required. No dashboard code changes (QUEUED rows never enter READY_FOR_REVIEW so operator list is naturally filtered).
>
> After changes: `npm run typecheck` must pass.

---

## Checkpoint (before committing)

- [ ] Fresh sandbox ingest: application with all required fields from supabase source → status is `QUEUED` immediately
- [ ] Application with one required field `source: 'ai'` → status is `READY_FOR_REVIEW`
- [ ] Application with one required field `source: 'unresolved'` → status is `READY_FOR_REVIEW`
- [ ] Optional-only AI fields → doesn't block auto-queue
- [ ] Re-ingest of an `APPLIED` row → status not changed
- [ ] Email sent to CA with correct clientCount and appCount after ingest
- [ ] CA with null `assigned_ca_email` → skipped silently
- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes

---


---

## Docs to update after checkpoint

> @AGENTS.md @.ai/progress.md @.ai/activeContext.md
>
> Move the following to Shipped in progress.md and update activeContext.md current session:
>
> - Auto-queue routing: applications where no required field is source=ai or unresolved are set to QUEUED at resolve time, skipping READY_FOR_REVIEW entirely
> - Operator queue now naturally shows only applications needing human review (AI-answered or unresolved required fields)
> - Post-ingest CA notification email: after Phase D, one HTML email per CA listing client count and application count, sent via Azure noreply, linking to gh.applywizz.ai