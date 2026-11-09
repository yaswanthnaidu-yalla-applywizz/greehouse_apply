# Task 1 Report: FADA persisted requiredness

## Result

Implemented `getPersistedRequiredness` and wired it into FADA's field aggregation. The helper treats boolean `isRequired` as authoritative, otherwise accepts legacy boolean `required`, and returns `false` for other values. It does not mutate the field object.

## TDD evidence

- RED, prescribed command: `node --env-file='.env' --import tsx tests/fadaRequiredness.test.ts`
  - It exited 1 before loading the test with `SystemError [ERR_SYSTEM_ERROR]: uv_os_get_passwd returned ENOMEM` from the installed `tsx` temporary-directory loader.
- RED, native Node fallback: `node --experimental-strip-types tests/fadaRequiredness.test.ts`
  - It exited 1 with `ERR_MODULE_NOT_FOUND` for `fada-field-requiredness.ts`, confirming the helper was missing before implementation.
- GREEN, `tsx` with a Windows compatibility preload: `node --env-file='.env' --import "data:text/javascript,process.geteuid=()=>0" --import tsx tests/fadaRequiredness.test.ts`
  - Exit 0; output: `fadaRequiredness compatibility checks passed`.
- GREEN, native Node fallback: `node --experimental-strip-types tests/fadaRequiredness.test.ts`
  - Exit 0; output: `fadaRequiredness compatibility checks passed`.

The database-backed FADA filter smoke run was not run, per the task constraint not to run FADA against the database. No FADA query, submission, retry, deploy, push, or merge was performed.

## Files in the commit

- `.agents/skills/fada/scripts/fada-field-requiredness.ts` — new helper.
- `.agents/skills/fada/scripts/fada-engine.ts` — imports the helper and replaces the local `Boolean(f.required)` classification.
- `tests/fadaRequiredness.test.ts` — four requested compatibility assertions.

Commit: `441d470c7ffccc1487dcb4fe016230bd6e35b370` (`fix(fada): read persisted isRequired fields`, amended after review).

## Self-review and concerns

- The compatibility rule is explicit and handles precedence correctly, including `{ isRequired: false, required: true }`.
- The original `tsx` command is blocked by this Windows Node environment's missing `process.geteuid`; the same test passed with a preload that supplies it, and with native Node TypeScript stripping.
- `.agents` is ignored by git in this checkout. The task files were force-added as requested. The FADA engine itself had no tracked baseline, so Git records that file as newly added in full (1,057 lines) rather than as a narrow diff. Its existing trailing whitespace was reported by `git diff --cached --check`; no unrelated whitespace cleanup was made.
- The requested production-data smoke check remains unverified because the assignment prohibited database-backed FADA execution.
- Unrelated dirty worktree files remain unstaged and unchanged by this task.

## Fix round 1/5: remove embedded database fallback

### Change

Removed the literal PostgreSQL fallback from `fada-engine.ts`. FADA now gets its connection string only from `DB2_URL`, `DATABASE_URL_2`, or `DATABASE_URL`; startup throws a clear configuration error if all are absent. Added a small pure config helper and tests for missing configuration and variable precedence. No credential was rotated and no external state was changed.

### RED/GREEN evidence

- RED: `node --env-file='.env' --import "data:text/javascript,process.geteuid=()=>0" --import tsx tests/fadaRequiredness.test.ts`
  - Exit 1 with `ERR_MODULE_NOT_FOUND` for the not-yet-created `fada-config.ts` module.
- GREEN: same command after implementation.
  - Exit 0; output: `fadaRequiredness compatibility checks passed`.
  - Covers the missing-env throw, `DB2_URL` precedence, `DATABASE_URL_2` precedence, `DATABASE_URL` fallback, and all four requiredness compatibility cases.
- Focused source check: `rg -n "postgresql://|1fs5MGOgMaiuXB16|DB2_CONNECTION_STRING|getFadaDatabaseConnectionString" .agents/skills/fada/scripts/fada-engine.ts .agents/skills/fada/scripts/fada-config.ts tests/fadaRequiredness.test.ts`
  - No connection URL or credential matched; results showed only environment-based configuration references.
- No DB-backed command was run. Credential rotation remains a human follow-up, as instructed.

### Files and review

Added `.agents/skills/fada/scripts/fada-config.ts`; updated `fada-engine.ts` and `tests/fadaRequiredness.test.ts`. The database helper takes an explicit environment record, returns the first configured variable in the existing priority order, and throws without exposing any value when configuration is absent. The `fada-engine.ts` baseline remains a full-file addition because it was ignored and untracked before Task 1; no unrelated behavior was edited during this fix round.

Amended commit: `441d470c7ffccc1487dcb4fe016230bd6e35b370`.

## Fix round 2/5: respect the `.agents/` local-cache boundary

### Change

Moved the reusable `getPersistedRequiredness` function to tracked `src/utils/fadaFieldRequiredness.ts`. The focused test imports it from that tracked location. The local FADA engine now imports it using `../../../../src/utils/fadaFieldRequiredness.ts`. The engine, old helper, and configuration helper remain as local working copies and will be removed from Git tracking in the follow-up commit; no local files are deleted.

### RED/GREEN and checks

- RED: `node --env-file='.env' --import "data:text/javascript,process.geteuid=()=>0" --import tsx tests/fadaRequiredness.test.ts`
  - Exit 1 with `ERR_MODULE_NOT_FOUND` for `src/utils/fadaFieldRequiredness.ts`, before the helper was added.
- GREEN: same command after adding the tracked helper.
  - Exit 0; output: `fadaRequiredness compatibility checks passed`.
- Focused `git diff --check -- src/utils/fadaFieldRequiredness.ts tests/fadaRequiredness.test.ts`: passed.
- Whole-worktree `git diff --check` reports trailing whitespace/newline issues in unrelated pre-existing `.ai` user changes; none were changed by this task.

### Commit plan and boundaries

Base before this fix round: `cc00ec40fbb65f98a619f90f6e6390f3a4db6774`. Per the shared-branch ruling, no history rebase/amend is performed; the fix lands as a follow-up commit. That commit will contain only the tracked requiredness helper and focused test, with Git tracking removed for the three `.agents/skills/fada/scripts/` files while preserving their local copies. No DB-backed command was run.

Follow-up commit: `b979461b3b22c1ade1a9053a73c9356ba0ef1d9e`. Post-commit GREEN passed. `git ls-files .agents/skills/fada/scripts` returned no tracked paths, and all three local files still exist. The ignored local engine imports the tracked helper from `../../../../src/utils/fadaFieldRequiredness.ts`.

## Fix round 3/5: track only the FADA engine integration

### Change

Updated the root `.gitignore` with a narrow exception chain that exposes only `.agents/skills/fada/scripts/fada-engine.ts` to Git. The engine stays credential-free, imports the tracked helper from `../../../../src/utils/fadaFieldRequiredness.ts`, and calls it for aggregation classification. `fada-config.ts`, the former local helper, other FADA scripts, and sibling `.agents` files remain ignored. No engine behavior was changed in this round.

Added `tests/fadaEngineRequirednessIntegration.test.ts` to check the engine import, aggregation call, absence of the old `Boolean(f.required)` expression, valid helper path, and the Git ignore boundary for both the engine and ignored sibling files.

### TDD and verification

- RED: `node --experimental-strip-types tests/fadaEngineRequirednessIntegration.test.ts` before the ignore change.
  - Exit 1 at the expected assertion: `Missing expected exception: fada-engine.ts must be visible to Git`.
- GREEN: `node --experimental-strip-types tests/fadaEngineRequirednessIntegration.test.ts` after the ignore change.
  - Exit 0: `FADA engine requiredness integration checks passed`.
- GREEN: `node --experimental-strip-types tests/fadaRequiredness.test.ts`.
  - Exit 0: `fadaRequiredness compatibility checks passed`.
- `git check-ignore -v` confirms `fada-config.ts`, `fada-field-requiredness.ts`, and `.agents/skills/prp/SKILL.md` remain ignored.
- No DB-backed FADA run, credential operation, submission, retry, deployment, push, or merge was performed.

### Commit scope

The follow-up commit contains only `.gitignore`, `.agents/skills/fada/scripts/fada-engine.ts`, and the new focused integration test, plus this report. Existing unrelated dirty worktree changes remain unstaged. The engine is recorded as a complete file because its previous copy was ignored and had no tracked baseline; its existing whitespace was left untouched.
