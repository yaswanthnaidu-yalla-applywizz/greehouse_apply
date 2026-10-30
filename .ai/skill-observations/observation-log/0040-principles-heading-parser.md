---
id: 40
title: "Active principle scan expects a different Markdown heading level"
status: open
type: open-source
skill: [task-observer]
proposes_skill: []
target_file: []
siblings_checked: "task-observer family: no family registry in project anchor; no declared siblings in installed skill list"
area: "Session-start active-principles parsing"
date: 2026-10-30
session_context: "The session-start scan reported that the principles file had no Active Principles heading, although the heading exists and its principle entries use level-two headings."
parked_until:
resolved:
resolution:
reference: ".ai/skill-observations/cross-cutting-principles.md"
commands_verified: none
---

**Issue:** `session-start-scan.sh` reported the active principles as unparsed. The file contains `## Active Principles`, followed by `## Principle 1` headings, but the scan ends the section at the first subsequent `##` and only counts `###` headings. This turns a valid, populated principles file into a false “could not parse” result.

**Suggested improvement:** Update the scan to recognize the heading levels actually used in the active principles file, and verify its printed headings against that file.

**Principle:** A metadata scan must parse the structure its source uses and independently verify an empty result before reporting absence.