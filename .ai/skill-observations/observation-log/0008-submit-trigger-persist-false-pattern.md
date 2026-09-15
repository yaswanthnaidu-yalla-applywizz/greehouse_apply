---
id: 8
title: "Submit-triggered onStatusChange calls must always pass persist:false"
status: actioned
type: internal
skill: []
proposes_skill: []
siblings_checked: "none — no family applicable; internal, project-specific handler pattern"
area: "Dashboard submission UX / duplicate-worker bug"
date: 2026-09-15
session_context: "Fixing duplicate worker assignment bug (same application dispatched to 2-3 workers)"
parked_until:
resolved: 2026-09-15
resolution: "handleTriggerSubmit response paths in index.html + FormRenderer.tsx now pass persist:false; IN_FLIGHT includes EMAIL_PROOF_PENDING; PATCH ignores naked QUEUED while in-flight. handleStatusChange still defaults persist=true — opt-in-only persistence not flipped."
reference:
---

**Issue:** `handleTriggerSubmit` in both `dashboard/public/index.html` and `dashboard/FormRenderer.tsx` called `onStatusChange(id, newStatus)` without a `{ persist: false }` flag. The `handleStatusChange` handler — absent that flag — fired `PATCH /api/applications/:id/status`, writing the local status back to the DB. After the worker had set `APPLYING`, the dashboard echoed the status it polled (`APPLYING`) through that route, which contained no guard at the time, and rewrote it to `QUEUED`. The queue daemon dequeued the same application into a second (and sometimes third) lane.

**Suggested improvement:** Establish a project rule: *all `onStatusChange` calls that originate from submit-flow bookkeeping (setting `SUBMITTING`, echoing badge refreshes, clearing submission state) must pass `{ persist: false }`*. Only explicit operator-action transitions (approve, reject, manual status override) should write through. Add a comment to `handleStatusChange` naming this invariant. When adding new submission flow states or new `onStatusChange` call sites, default to `persist: false` and opt in to persistence only when the call represents a deliberate operator action.

**Principle:** A display refresh and a state write are semantically different acts. When a UI handler conflates both in a single callback, any call site that reads a polled or derived status and passes it to the callback is a silent state write. The callback must require the caller to opt *in* to persistence, not opt out — an omitted flag defaults to the safe action (display only), never the irreversible one (DB write).
