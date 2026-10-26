---
id: 30
title: "Candidate location extracted from historical work sections"
status: actioned
type: open-source
skill: [answer-resolver]
proposes_skill: []
siblings_checked: "none"
area: "resolver / candidate location extraction"
date: 2026-10-08
session_context: "diagnosing drop in Greenhouse submission success rate and location mismatches"
parked_until: ""
resolved: 2026-10-08
resolution: "Reverted location resolver changes and removed section scanning from experience/education"
reference: ""
---

**Issue:** When attempting to improve candidate location extraction from resumes without header locations, the resolver was modified to scan the `PROFESSIONAL EXPERIENCE` and `EDUCATION` sections. This caused past employment locations (e.g. Hyderabad, India) to be extracted as the candidate's current residence, overriding authoritative US addresses from the candidate profile (e.g. Fairborn, OH) and causing widespread application rejections and failures.

**Suggested improvement:** Enforce strict separation between candidate residence (profile header / contact lines only) and historical work locations. Never scan past work experience or education sections to infer current candidate residence.

**Principle:** Current entity attributes must never be extracted from historical narrative bodies where past or external entities are discussed.
