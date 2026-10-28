---
id: 35
title: "Private-copy identity must match execution identity"
status: open
type: open-source
skill: [rsift]
proposes_skill: []
siblings_checked: "none: rsift has no configured skill family in this workspace"
area: "private workspace preparation and native execution"
date: 2026-10-27
session_context: "A repository appraisal prepared its private source copy under an offline sandbox identity, then retried npm with network access under the user's identity. The second identity could not read the lockfile or write node_modules."
parked_until: ""
resolved:
resolution: ""
reference: "C:\\Users\\yaswa\\AppData\\Local\\Temp\\rsift-greehouse-20261027-final"
---

**Issue:** A private execution copy can be complete and hash-verified yet unusable when its owner differs from the identity that receives network access. The resulting permission errors resembled npm cache and registry failures until both identities were tested separately.

**Suggested improvement:** In RSift's execution-safety workflow, probe the exact execution identity for read access to the lockfile and write access to the private source and cache before installation. If network escalation changes identity, prepare the private copy under that identity or grant access before running repository commands.

**Principle:** A private copy is executable only when the identity that runs repository commands can read its inputs, write its outputs, and reach required external services. Verify all three boundaries with the same identity before interpreting command failures as repository evidence.
