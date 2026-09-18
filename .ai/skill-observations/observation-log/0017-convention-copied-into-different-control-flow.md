---
id: 17
title: "A convention copied into a different control-flow context changes what a failure means"
status: open
type: open-source
skill: []
proposes_skill: []
siblings_checked: "resolver fallback family (0002 permissive fallback, 0013 safety-net gate) is adjacent but distinct: those are about a fallback returning a wrong result, this is about an added statement creating the failure the fallback then absorbs"
area: "porting a local code idiom; control flow and error-handling context"
date: 2026-09-18
session_context: "Added a fire-and-forget application_events insert to getNextQueuedApplicationForRoundRobin() (RPC + fallback dequeue branches) to record QUEUED -> APPLYING"
parked_until:
resolved:
resolution:
reference: "src/db/applications.ts getNextQueuedApplicationForRoundRobin (RPC branch call, fallback branch call); src/db/events.ts insertApplicationEvent"
---

**Issue:** The file's own convention for the exact call being added — used twice in the same file — is `const { insertApplicationEvent } = await import('./events.js'); void insertApplicationEvent({…})`. Copying it verbatim into the first dequeue branch would have placed a new `await` inside a `try` whose `catch` is empty and deliberately falls through to a catch-all fallback query. That fallback selects the next row with `status = 'QUEUED'` — and the row the RPC just transitioned to `APPLYING` is no longer `QUEUED`, so the fallback cannot re-select it; it selects a *different* application. A throw from the newly added statement therefore converts a failure that was previously impossible into a second dequeue of an unrelated application while the first is already committed as `APPLYING`. Nothing was wrong with the idiom: the pre-existing statements in that `try` (`cacheApplicationLocally`) cannot throw, so the fall-through was latent and harmless until a new statement introduced a throw point. The second variant of the same idiom, `void import('./events.js').then(cb)`, trades the fall-through for an unawaited promise with no `.catch` — an unhandled rejection, which terminates the process by default in current Node.

**Suggested improvement:** When reusing an idiom found elsewhere in the file, inspect the destination context rather than the idiom: does the enclosing `try` have a `catch` that continues into a different code path, and would entering that path be wrong? Does this statement add a throw or await point where none existed? Does the local convention assume the caller can survive its failure? An idiom is portable only when its failure semantics are, and the cheaper repair is usually to pick a form with no failure point at all — here, a static module import plus `void call`, which satisfies "fire and forget" without adding either hazard.

**Principle:** An idiom's correctness is a property of its context, not its form. Reusing a local convention is normally the safest move, which is precisely what makes it risky: familiarity suppresses the context check, and the introduced risk is not in the new behaviour but in what the surrounding error handling does with a failure it previously could not receive. The strongest tell is a `catch` whose body does something other than handle — logging and continuing is benign, but falling through to a second attempt is a statement about which failures the author believed could occur, and adding a statement is how that belief goes stale.
