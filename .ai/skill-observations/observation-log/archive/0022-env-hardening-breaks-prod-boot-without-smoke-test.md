---
id: 22
title: "Hardening environment variable schema can break production startup when unused secrets lack defaults and CI lacks a runtime smoke test"
status: actioned
type: open-source
skill: []
proposes_skill: []
siblings_checked: "none: no existing observation covers env schema validation breaking container boot or CI blind spots"
area: "environment configuration and CI pipeline verification"
date: 2026-09-21
session_context: "Hardening SEC-5 removed JWT_SECRET default in env.ts, which crashed Railway on boot because production uses Supabase Auth and does not set JWT_SECRET; CI build only ran static tsc/vite build and missed the crash"
parked_until:
resolved: 2026-09-21
resolution: "Restored safe default for JWT_SECRET in env.ts with a production warning log if unset, and verified server boot smoke check locally"
reference: "C:\\Users\\yaswa\\Downloads\\logs.1789965843498.json"
---

**Issue:** During a security hardening pass, removing fallback defaults on schema-validated environment variables (`JWT_SECRET: z.string()`) caused a production container crash on startup (`Invalid environment configuration: JWT_SECRET Required`). The variable was not actually used in production authentication (Supabase Auth is used instead), so it was never set in Railway environment variables. The crash was not caught by CI because the CI `build` step only executed static checks (`tsc && vite build`), while `npm test` ran with `continue-on-error: true`.

**Suggested improvement:** When hardening environment variable validation schemas, verify whether the secret is actually active and configured in all deployment environments before making it required without a fallback. Additionally, ensure CI includes an explicit server startup smoke test (e.g. importing the server bundle in Node) in the blocking build job so environment schema parsing failures fail the build before deployment.

**Principle:** Static compilation passes (tsc, bundlers) do not execute module-level runtime validation; environment schema enforcement must be paired with an automated runtime smoke test in CI and audit of deployed environment variables.
