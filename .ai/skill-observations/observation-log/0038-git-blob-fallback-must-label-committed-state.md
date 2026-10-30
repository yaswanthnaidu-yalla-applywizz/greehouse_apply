---
id: 38
title: "Git-blob fallback must label committed-state evidence"
status: open
type: open-source
skill: [how, why, architect, blast-radius]
proposes_skill: []
siblings_checked: "investigation and design family: how, why, architect, blast-radius — shared, all added; no skill-families catalog was present"
area: "source acquisition when filesystem ACLs block tracked files"
date: 2026-10-29
session_context: "Grounding a safe decomposition design for large TypeScript modules on Windows"
parked_until: ""
resolved:
resolution: ""
reference: ".ai/architecture/god-file-decomposition/design.md"
---

**Issue:** Windows ACLs denied direct reads of several tracked source and test files during architecture exploration. Reading the same paths from Git blobs recovered the committed content and proved an import-graph fact, but Git blobs cannot reveal dirty working-tree edits. Treating the fallback as current working-tree evidence would make a design or blast-radius claim unsound.

**Suggested improvement:** Add a source-acquisition fallback to the investigation skills. When a tracked path returns access denied, read the committed blob with git show HEAD:<path>, compare the path against git status --short, and label every resulting claim as committed-state only. If the path is dirty or untracked, stop rather than infer its current contents.

**Principle:** A fallback observation method must state which version of the artifact it can see. Committed content is useful evidence, but it is not evidence of an unreadable working tree.
