---
id: 34
title: "Session-start scans must use the pinned workspace anchor"
status: open
type: internal
skill: [task-observer]
proposes_skill: []
target_file: []
siblings_checked: "no family registry in this project anchor; available skill names checked, no task-observer sibling shares this session-start workflow"
area: "Session Start Protocol after context resume"
date: 2026-10-16
session_context: "Failure-analysis follow-up and commit/PR workflow, and reportkaro skill update; repeated the wrong-root scan before correcting it"
parked_until:
resolved:
resolution:
reference:
commands_verified: none
---

**Issue:** After context resume, the session-start scan was first given the repository root instead of the pinned `.ai` workspace anchor. The scan emitted missing-path errors and a misleading zero-file result; rerunning it with the correct anchor succeeded.

Repeated on 2026-10-16 during a commit/PR task: I passed the repository root to the scan again, so it looked under the wrong directory and returned a misleading zero-file count. The follow-up used `.ai` and read the expected two entries. The first command also printed checkpoint-write errors while exiting zero, reinforcing the need to inspect output rather than trust exit status.

Repeated again on 2026-10-16 during this reportkaro skill-update task: I initially passed the repository root instead of `.ai`; the scan emitted missing-path errors and a zero-file result, then succeeded with `.ai`.

**Suggested improvement:** Add a structural preflight to `session-start-scan.sh` that requires `root/skill-observations/observation-log` to exist and exits non-zero before scanning or writing a checkpoint when the anchor is wrong. Add a regression check proving the repository root is rejected clearly and `.ai` succeeds. This is a proposed barrier, not a reminder; it was not implemented in this task.

**Principle:** A resumed workflow must use its configured persistent-state root, not infer that root from the repository working directory.