# Active Context — Current Sprint State

_Last updated: 2026-09-16_

## Current Focus

### 1. Role assignment authorities (in progress)
- Sign-in should read **`users.role`** when present and embed in JWT; hardcoded dev/admin/manager emails still win.
- If no `users` row: CA emails API gate → create operator row in `users`.
- Existing row bypasses CA API for authorization.
- **Not shipped yet** — today role still comes from `ROLE_BY_EMAIL` + `persistRoleClaim` on login only.

### 2. Manager CA / team filtering (shipped this session — verify in prod)
- **`users.manager_email`** populated on operator login via work-history + CA manager UUID map (migration **017**).
- **`MANAGER_TEAM_SCOPE_ENABLED = true`**: manager dashboard + `GET /api/candidates`, `/jobs`, `/stats`, **`GET /api/users`** scoped to operators where `manager_email =` signed-in manager.
- Dev/admin see all; dev bypasses role guards as before.
- **Next:** confirm operators have `manager_email` after login; smoke-test manager `/manager` and any shared list APIs.

### 3. Resolution engine (background)
- Semantic / fuzzy Tier 2+3 improvement — approach not chosen.

## Immediate Blockers / Open Questions
- [ ] Apply migration **017** (`users` table) in Supabase if not applied.
- [ ] Apply migration **016** (`profiles.country`) if ingest/profile create still fails.
- [ ] Railway Storage ingest keys (`service_role` JWT) — still open if ▶ Start lists zero files.
- [ ] Role-from-`users` sign-up/login flow (item 1 above).

## Recent Decisions Made
- Manager team scope uses **`users.manager_email` → operator emails → `assigned_ca_email` / work-history union**, not ApplyWizz `careerassociatemanager_id` API alone.
- Operator queue shows **all** application rows (including SKIPPED); blocked statuses use operator-friendly **`error_message`** in the form panel.
- Default dashboard date window: **Today & Yesterday** (IST) unless `?from=&to=` override.
