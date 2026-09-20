---
id: 15
title: "Project skills under .cursorignore cannot be loaded with the Read tool"
status: actioned
type: project
skill: []
proposes_skill: []
siblings_checked: "none: session-start load path, not a product skill family"
area: "AGENTS.md session start / .cursorignore / task-observer"
date: 2026-09-17
session_context: "AGENTS.md requires loading .ai/skills/task-observer/SKILL.md before the first tool call; Read returned Permission denied"
parked_until:
resolved: 2026-09-17
resolution: "Used Shell Get-Content for SKILL.md, observation-log, and checkpoints.log. Session start/end written via Shell."
reference: ".cursorignore lines for .ai/skills/task-observer/ and .ai/skill-observations/"
---

**Issue:** `.cursorignore` excludes the task-observer skill bundle and the observation log so they stay out of the code index. The Read/Write/Grep tools honor that ignore and fail with permission denied. AGENTS.md still requires those files on session start. The first Read of SKILL.md failed; Session Start did not run until Shell was used later.

**Suggested improvement:** Document in AGENTS.md that task-observer files must be read and written with Shell (or remove those two paths from `.cursorignore` if the index cost is acceptable). Do not treat a Read denial as "skill missing."

**Principle:** An ignore rule that hides mandated session files from the default file tools is a silent protocol skip unless the fallback tool is named in AGENTS.md.
