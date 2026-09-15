---
id: 5
title: "A probe rewritten in transit returns a false negative that reads as a finding"
status: open
type: open-source
skill: []
proposes_skill: []
siblings_checked: "none: no skill family"
area: "writing verification probes; passing code through a shell"
date: 2026-09-15
session_context: "Parsing an inline JSX block out of an HTML file to verify an edit had not broken it"
parked_until:
resolved:
resolution:
reference:
---

**Issue:** A verification script was passed to an interpreter as a command-line argument (`node -e "<program>"`) from PowerShell. PowerShell strips embedded double quotes when handing arguments to a native command, so the program that actually ran was not the program that was written: the search string `<script type="text/babel">` arrived as `<script type=text/babel>` and matched nothing. The script reported that the file contained no script block. Every part of the probe was correct — the regex, the file path, the logic — and it still produced a confident wrong answer, because the layer between authoring and execution rewrote the source. The only reason this did not become the conclusion "the file has no inline script, nothing to verify" is that the probe carried an explicit `PROBE BROKEN` branch distinguishing "found zero" from "could not look". Rewriting the same program into a file and invoking it by path returned the correct result immediately.

**Suggested improvement:** Do not pass a program containing quotes or escapes through a shell as an inline argument when its output will be trusted as evidence; write it to a file and invoke the file. Where an inline form is unavoidable, have the probe echo back one literal it depends on, so a rewritten source is visible in the output rather than silently changing the answer. Keep the explicit broken-instrument branch regardless: it is what converts this failure from a wrong conclusion into a retry.

**Principle:** A probe's correctness is not a property of the code as written but of the code as executed, and any layer in between — shell quoting, template interpolation, an escaping step, a config parser — can rewrite it into a different, still-valid program that answers a different question. This failure mode is invisible by construction, because the rewritten program does not error; it succeeds and returns the answer to the question nobody asked, which is almost always the negative one ("no matches", "zero results") that reads as a finding about the data. The guard is to never let a zero speak for itself, and to shorten the path between where a probe is written and where it runs.
