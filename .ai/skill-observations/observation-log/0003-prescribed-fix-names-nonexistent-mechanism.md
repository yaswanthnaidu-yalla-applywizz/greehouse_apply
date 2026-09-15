---
id: 3
title: "A bug report's prescribed fix can name a mechanism the code does not have"
status: open
type: open-source
skill: []
proposes_skill: []
siblings_checked: "none: no skill family"
area: "diagnosis before implementation; reading a defect report against the code"
date: 2026-09-15
session_context: "Double-submission report: 'after OTP solve fails to FAILED, the queue immediately re-picks the same app', with a four-point fix prescribed for src/submitter/queueWorker.ts"
parked_until:
resolved:
resolution:
reference: "logs.1789452368028.log"
---

**Issue:** The report was precise, confident, and specified the file and the four changes to make (do-not-requeue flag on OTP/CAPTCHA failure, reason-gated requeue, per-application cooldown, a log line). Implementing it as written was straightforward and would have produced a plausible-looking diff. But the named file, `queueWorker.ts`, is a 57-line daemon wrapper with no queue logic at all, and no requeue-on-failure path exists anywhere in the codebase: the dispatcher selects only `status = 'QUEUED'`, and nothing transitions `FAILED → QUEUED` except an explicit operator submit. The real chain was in the opposite direction — the dashboard echoes the polled status back via `PATCH /:id/status`, the route rewrites `APPLYING → QUEUED` unconditionally, and the pool re-dequeues an application it is already running because it has no in-flight guard. The OTP and CAPTCHA failures the report keyed on were downstream effects of three browsers racing on one form, not the trigger. A per-application cooldown would have suppressed the symptom in testing while leaving both defects in place.

**Suggested improvement:** Before implementing a fix that a report prescribes, confirm the mechanism it names actually exists and actually fires: locate the code that performs the described transition and find it in the evidence. Where the report supplies logs, reconstruct the ordered timeline of the causal transitions rather than grepping for the terms the report used — searching for `OTP` and `FAILED` reproduces the reporter's hypothesis, while reading the transitions in order exposes it. When the two disagree, report the discrepancy before writing code.

**Principle:** A defect report contains two separable claims — the symptom, which the reporter observed, and the mechanism, which the reporter inferred — and only the first is evidence. A prescribed fix silently converts the inference into a specification, and its very specificity (file, flag, log string) suppresses verification, because a task that detailed reads as already diagnosed. The more actionable the prescription, the more it is worth locating the named mechanism in the code before touching it: a fix aimed at a mechanism that does not exist can still make the symptom disappear in the reporter's reproduction, which is the outcome that ends the investigation with both real defects intact.
