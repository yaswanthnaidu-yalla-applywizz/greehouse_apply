---
id: 12
title: "A privilege flag must not be reused as the user's role"
status: actioned
type: open-source
skill: []
proposes_skill: []
siblings_checked: "none: no skill family"
area: "role resolution after login / session restore"
date: 2026-09-15
session_context: "Dev email yaswanthnaiduyalla@applywizz.ai was redirected to /admin because applywizz_is_admin was true for both admin and dev"
parked_until:
resolved: 2026-09-20
resolution: "Resolved via ROLE_BY_EMAIL mapping and sessionRole() in roleAccess.js, attachResolvedRole in server auth routes, and migration 015 dashboard_users.role; applywizz_is_admin no longer overrides role resolution."
reference:
---

**Issue:** Login set a shared `is_admin` flag for both admin and developer. Session restore then treated that flag as the role, so the developer landed on the admin dashboard instead of the developer dashboard.

**Suggested improvement:** Resolve role from a canonical identifier (email map, JWT claim) on every page load. Keep privilege flags for "can do X" only. Never map `is_admin === true` to `role = admin`.

**Principle:** A boolean that means "privileged" will collapse distinct roles when it is later read as the role itself.
