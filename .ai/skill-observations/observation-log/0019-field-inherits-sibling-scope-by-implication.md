---
id: 19
title: "A field added to a stats row inherits its siblings' scope by implication and nothing else"
status: open
type: open-source
skill: []
proposes_skill: []
siblings_checked: "0003 covers false premises (a spec asserts something about the code that is untrue); this is the underspecified case — the predicate is absent rather than wrong, and the literal implementation compiles and runs. 0016 is about checks that pass while the shape is wrong; nothing is being verified here, a definition is simply incomplete."
area: "implementing a spec whose new field omits a scope qualifier its neighbours carry"
date: 2026-09-18
session_context: "Added apps / completed / approved to each operator row of GET /api/manager/reports; two fields named their window (periodStart), the first named none"
parked_until:
resolved:
resolution:
reference: "src/server/routes/manager.ts GET /api/manager/reports (perOperator construction)"
---

**Issue:** A spec asked for three derived fields on every operator row of a reports endpoint. Two named their window explicitly — `completed = countCompletedApplicationsSince(periodStart, [email])` and `approved = … AND updated_at >= periodStart` — while the first said only "apps: total candidate_applications count where assigned_ca_email = operator.email", with no date or status predicate at all. The same row already carried `applications`, the period-scoped count of the same table. Implemented literally, `apps` is an all-time count and renders beside its neighbours as 400 next to 12: every other figure in that row is window-scoped, so the one that is not reads as a defect rather than a decision. The omission is a single clause inside a three-item list, which is precisely the shape in which an oversight and a deliberate choice are indistinguishable — and unlike a false premise, nothing fails: the code compiles, the endpoint returns 200, and the number looks like data.

**Suggested improvement:** Implement the predicate literally, then surface the asymmetry in one line — silently adding the missing bound is an unrequested behaviour change, and silently shipping it without comment produces a figure that will be re-reported as a bug. Name both readings and the numbers they produce ("all-time vs period-scoped") so the author can choose in a sentence. The tell to watch for is a field whose predicate is strictly weaker than every sibling's in the same object: scope qualifiers are a property of the row's shared semantics, so a lone exception is more often a dropped clause than a deliberate metric.

**Principle:** A new field is read against its neighbours rather than in isolation. When an addition sits inside a collection whose other members all carry the same scope qualifier, that qualifier is supplied by the reader's inference and by nothing in the implementation — so the literal version and the "consistent" version diverge silently, and only an explicit note in the handoff lets the author pick. This class of ambiguity is cheap to raise and expensive to discover, because a wrong-but-plausible aggregate is indistinguishable from correct data downstream.
