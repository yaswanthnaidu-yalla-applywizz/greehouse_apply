---
id: 9
title: "A hard-rule file that still names the old cap will be followed after the cap has already moved"
status: actioned
type: open-source
skill: []
proposes_skill: []
siblings_checked: "none: no skill family"
area: "keeping AGENTS.md / hard rules in lockstep with config changes"
date: 2026-09-15
session_context: "Session-end doc pass after 716b42d raised MAX_JOB_QUESTIONS 23→35 and 014 added SKIPPED"
parked_until:
resolved: 2026-09-15
resolution: "AGENTS.md rule 7 now states the cap is 35 and must not be raised further without an explicit instruction. projectbrief/techContext already had 35; progress pending table no longer says lift <23."
reference: "commit 716b42d, AGENTS.md Hard Rules"
---

**Issue:** `AGENTS.md` still said "do not lift `MAX_JOB_QUESTIONS`; the `< 23` filter is intentional" after `716b42d` set the default to 35 and over-cap jobs became `SKIPPED`. An agent following the hard-rule file would treat 35 as a violation or keep documenting `< 23`.

**Suggested improvement:** When a numbered hard rule encodes a numeric cap (or any constant also in `env.ts`), update that rule in the same change that moves the constant. Session-end doc passes should grep AGENTS.md for stale numbers, not only `.ai/*.md`.

**Principle:** The file that claims to bind future agents must name the current contract, not the contract from last month.
