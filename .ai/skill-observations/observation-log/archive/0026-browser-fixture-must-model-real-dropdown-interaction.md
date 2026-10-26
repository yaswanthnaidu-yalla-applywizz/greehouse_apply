---
id: 26
title: "Browser fixtures must model real dropdown event and portal behavior"
status: actioned
type: open-source
skill: task-observer
proposes_skill: []
siblings_checked: "0018 covers per-surface verification gaps; this observation concerns browser fixture fidelity to framework interaction mechanics."
area: "browser automation regression coverage"
date: 2026-10-06
session_context: "A Greenhouse option-enrichment test passed while its custom menu opened on click and stayed inside the field wrapper; the reported live control depended on pointer/mousedown interaction and could render options in a portal."
parked_until:
resolved: 2026-10-06
resolution: "Regression fixture now requires mousedown and renders options in a portal; scanner opens controls through Playwright pointer interaction."
reference: "tests/liveChoiceOptions.test.ts and src/scanner/liveChoiceOptions.ts"
---

**Issue:** A browser-backed test gave false confidence because the fixture simplified the custom control's event semantics and menu placement. The helper's synthetic `.click()` passed that fixture but did not reliably open a React-backed Greenhouse select that responds to pointer/mousedown, and wrapper-scoped option lookup would miss a portal.

**Improvement:** For browser automation tests, model the real control's interaction event and rendering topology. Use Playwright's user-level pointer interaction where framework handlers depend on it, and include portal-rendered menus when the production UI can portal them.

**Principle:** A passing browser test validates only the interaction and DOM contract it models; fixture fidelity must include framework event semantics and portal placement, not just matching labels and visible text.
