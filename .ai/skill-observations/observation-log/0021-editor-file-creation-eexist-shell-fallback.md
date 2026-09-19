---
id: 21
title: "Editor file-creation fails with EEXIST mkdir in this workspace; create new files via shell instead of retrying"
status: open
type: internal
skill: []
proposes_skill: []
siblings_checked: "0015 is about reads blocked by .cursorignore - a different tool friction with a different workaround (permission grant). Nothing in the log covers editor create failing while editor edit succeeds."
area: "harness tooling - file creation via the editor tool"
date: 2026-09-18
session_context: "Creating .tmp-verify-manager-jsx.mjs then tmp-verify-manager-jsx.mjs both failed with EEXIST: mkdir C:\\Users\\yaswa\\Dev\\greehouse_apply while same-session edits to existing files succeeded; Set-Content + node ran the same content first try"
parked_until:
resolved:
resolution:
reference: "session tool calls on C:\\Users\\yaswa\\Dev\\greehouse_apply (editor create attempts vs run_commands Set-Content)"
---

**Issue:** Two consecutive editor attempts to create new files in the workspace root failed with EEXIST: mkdir on the already-existing directory - the tool appears to attempt directory creation without treating an existing target dir as success. The failure is silent as to cause (a bare EEXIST that looks like a file collision, inviting wrong fixes like renaming), and it is scoped to creation only: edits to existing files in the same directory work normally, so the diagnosis is not obvious from the error alone.

**Suggested improvement:** Treat editor-create EEXIST-on-directory as an environment signature, not a name collision: one rename attempt is enough to rule out a genuine collision, and beyond that switch immediately to shell file creation (Set-Content / here-string) and keep the editor for edits to existing files. Record the split (create via shell, edit via editor) as the default for the session rather than re-probing the broken path.

**Principle:** A tool error that persists across a changed filename is an environment failure, not a naming problem; probe once, then reroute the workflow instead of retrying the failed path with variations.
