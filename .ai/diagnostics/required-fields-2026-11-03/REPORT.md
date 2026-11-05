# Required-field investigation — 2026-11-03

Diagnostic experiments only. Production source and DB records were not changed. No applications were submitted. These are targeted control replays, not complete end-to-end application runs.

## Live reproduction and corrections

| Case | Unmodified behavior | Experimental correction and observed result |
|---|---|---|
| LAPORTE Allen-Bradley years | Stored `0` becomes `No`; menu has no result | Preserve exact catalog values before boolean normalization. Live `0`, `1`, and `2-4` selected successfully. |
| Strata custom address Country | Country classifier and selector priority target phone `#country`, report success, leave address empty | Exact field selector plus separating the custom address field from phone handling selects `USA`. Phone control still selects United States +1. |
| Pelago Manhattan office | Search rewrites em dash to ASCII hyphen; live menu becomes empty | Preserve original option text while typing. The existing filler then selects the exact relocation answer. |
| Reddit numeric ID 431 | Invalid ID selector falls through to substring match: LinkedIn `question_69882431`; `No` is typed into LinkedIn | Exact attribute selector targets 431. Four live demographic controls (431–434) accept their intended answers. |
| Discord | Numeric IDs share the selector risk | Exact selectors fill both tested race controls. Diagnostic option selections were not submitted. |
| Samsung month controls | Stored ISO dates do not match month options | Existing filler accepts October on both employment and education month controls. October was a mechanical probe, not verification that October is the candidate's correct historical month. |

Primary logs: `tmp-required-diagnostic.log`, `tmp-reddit-probe.log`, `tmp-required-experiment.log`, `tmp-required-regression-final.log`.

Prototype changes are not a release patch. In particular, excluding every `question_` ID from phone handling is only an experiment: production classification must use phone context/options, since custom questions can also ask for dialing codes. Numeric preservation should use an exact catalog match before boolean aliases, not a blanket rule that every 0/1 is numeric. Preserve original search text first; normalize comparisons and use a bounded alternative search only when necessary.

## Validation and regression checks

On the actual LAPORTE page, filling Phone and appending a repaired result still leaves the old phone failure in the gate. Replacing the failed result with the verified result removes the phone failure while another required failure remains blocked. See `tmp-required-safety-final.log`. Field identity must include the actual control/name where normalized IDs repeat; never discard every earlier failure merely because a later record has the same generic ID.

Native control checks: numeric 0 and literal Yes work. Numeric alias 1 against native Yes/No fails in both baseline and experiment; this is an existing limitation, not a demonstrated regression. The browser regression run with 2-second global timeouts was invalidated by navigation and long-answer typing timeouts. The final run used 30-second navigation and 5-second locator timeouts.

The proposed label lookup was tested on Smartsheet, WPP, DRW, Fanatics, HawkEye, and Discord. The first attempt failed because `.select-shell` excludes the label. Resolving through the outer `.select` finds labels for all 50 initially unnamed invalid controls across those fresh forms. These are fresh blank-form controls, not attribution of all historical unknown failures. See `tmp-required-labels-fixed.log`.

The gate also deduplicates invalid fields by `fieldId`. All anonymous required inputs currently become `unknown`; distinct failures can collapse to one. Derive identity from the associated combobox before deduplication. This diagnosis change should preserve blocking behavior.

## Resolution: Samsung

DB2 records all four date-month fields as `optionsComplete=false`. The candidate's raw additional information contains `start_date=2026-10-05` and `end_date=2026-11-04`; these exactly match the incorrect stored month answers. Structured education has a graduation year but no start/end months.

Execution path:

1. `answerResolver.ts:566` removes options from incomplete catalogs before tier resolution.
2. `tier1Supabase.ts:122` cannot obtain a month from the structured education record.
3. `tier1Supabase.ts:777` matches generic raw keys by substring; `start date` matches `Start date month`.
4. With no options, `matchBestOption` returns the full date unchanged.
5. `answerResolver.ts:183` allows an unmatched value to survive when options are incomplete.

Executed the real raw-payload matcher and real alignment function: both return `2026-10-05` for Start date month. This is a reproduced resolution bug, not just an inferred formatting issue.

Fix boundaries: date-component resolution must retain field meaning even when a catalog is incomplete. Match employment dates to the corresponding employment record and education dates to the corresponding education record. Reject generic payload date matches for these contextual components; use existing month extraction only after provenance is established. Do not map both sections from one generic start/end pair. Preserve incomplete-catalog tolerance for genuinely open catalogs such as school search. Re-resolve affected fields after correcting provenance; do not merely convert all existing ISO strings into month names.

## Resolution: Walker-Miller GED

The stored template contains only newsletter Email and the Constant Contact honeypot. The live parent page contains that newsletter; the real application is in a Greenhouse iframe and contains the required GED question. The scanner checks loaded frame URLs immediately after DOMContentLoaded (`playwrightScanner.ts:477–490`), so asynchronous attachment is a plausible failure mechanism. The historical scan timing itself was not reproduced, so distinguish the confirmed wrong template from the timing hypothesis.

Following the live iframe and running `extractVisibleFormFields` produces the correct required GED question. `getEffectiveFieldOptions` yields Yes/No. Candidate AWL-41702 already has a related cached GED answer Yes. Running the real fuzzy resolver with that stored entry returns Yes; choice alignment preserves it; the live control accepts it. This clears the proposed need for a blanket GED default or a new resolver tier.

Fix boundary: on embedded ATS pages, wait for or resolve the actual ATS application frame before accepting a generic parent form. Reuse `findEmbeddedGreenhouseApplicationUrl`; rescan the affected stale templates and re-resolve through existing tiers. Preserve the 35-question cap. Do not treat a newsletter form as a valid application scan.

The failure event preserves only the final empty-field message, not intermediate tier outputs. The exact historical reason that this dynamic resolution yielded an empty GED answer remains unproven. No conclusion about all 13 candidates' education or cached answers follows from the one candidate replay.

## Not established by this run

- Complete application success, OTP passage, or successful submission.
- The filtered-education retry-index defect was source-traced previously but not exercised through complete fillForm here; do not include it in a release patch as a proven cause of this cohort.
- Historical causes of all eight unnamed failures. The label fix now makes future reproductions diagnosable.
- All-country, all-ATS, headful, and multi-select regression coverage. Tested browser runs were headless.

Archived `.ts.txt` files contain the diagnostic scripts and isolated source copies. They were removed from the production source tree after execution. To rerun, restore the diagnostic copies at the original import paths in a disposable checkout. Logs and screenshots remain in this directory.

## Follow-up: Cross River replay — 2026-11-05

The current Cross River parent page hosts a Greenhouse embedded application. It exposes one visible `Country*` field with ID `country`; it is the phone-country React-Select control. The historical screenshot showed a different country state, so the current form cannot establish that the historical missing field was an address country.

Running the unmodified `fillSingleField` against this live control reports `success: true` and `domCommitted: true`, but the control has no selected value afterwards and the form still reports two anonymous hidden required inputs as invalid. A direct exact click on the live `United States +1` option produced the same result in this isolated blank form. The replay therefore proves that the current filler result is not a reliable browser-validity proof for this layout, but it does not identify whether the remaining invalid input is the country control or another required widget.

The safe implementation boundary is to make React-Select success depend on the form's associated hidden required input or visible selected value, then let the existing gate block the submission when neither changed. Do not mark the control committed merely because a menu option was clicked or the search text matched. The archived `crossriver-probe.mjs` reproduces the behavior.

## Follow-up: Cross River replay after commitment fix — 2026-11-05

Replayed `crossriver-probe.mjs` against the current embedded application without submitting. The page exposes `#country` as a visible `Country*` combobox and one matching `United States +1` option. After the option click, the filler now returns `success: false` and `domCommitted: false`; the input value and selected-value display remain empty. The form still reports two anonymous empty required inputs as invalid. This confirms that an available/clickable country option does not prove selection on this layout; the submission gate must retain both required failures.

## Follow-up: combined required-field integrity fixture — 2026-11-05

Added `tests/greenhouseRequiredFieldIntegrity.test.ts`, a local HTTP fixture that calls the real `AnswerResolver`, `fillSingleField`, and `validateGreenhouseSubmission`. It uses only synthetic profile/context data, local HTML, and a local embedded iframe; it does not use a candidate record or submit a form. The required valid policy choice passes the gate. A click-only searchable choice whose display and hidden required value remain empty fails filling and remains blocked by the gate. An unknown-context date resolves as `unresolved`. The fixture also exercises literal numeric option `0`, an em-dash choice, numeric ID `431`, separate address and phone-country controls, and a Greenhouse iframe.

The new fixture passed headless and headful on this workstation (1/1 in each mode). The test defaults `TEST_HEADLESS` to `true`; the headful run set it to `false`. Initial sandbox runs failed before the test loaded with Node `uv_os_get_passwd ENOMEM`; the same local test passed when rerun with escalation. No submission or remote request was made by this fixture.

Verification results:

- `npm.cmd run typecheck`: passed. The current worktree includes an uncommitted TypeScript cast in `formFiller.ts:513` needed by the preceding implementation; the Task 5 evidence commit does not include that source change.
- `ENABLE_STATS_ROLLUP=false; npm.cmd run test:unit`: passed, 73 Node tests and 55 Vitest tests. The worktree `.env` does not define the required `ENABLE_STATS_ROLLUP`, so the flag was supplied explicitly. Test logs include a simulated Anthropic 429 and expected failure-diagnostic messages; no test failed.
- The targeted Vitest command passed 4 files / 31 tests. `tests/formFillerNormalization.test.ts` is a `node:test` file and Vitest reports “No test suite found”; run separately under Node, where all 11 tests passed. This is a runner mismatch, not a failing normalization assertion.
- Blast-radius Node run passed: searchable-select 18/18; normalization 11/11; dynamic cascade 1/1; embedded Greenhouse scanner 5/5. The cascade case passed while logging that its synthetic candidate had no resume storage and its embedding request returned HTTP 402; those paths remain unverified by this fixture and are not called fixed here.

The tested safety fact is that filler success for a custom choice requires a corresponding selected display value or associated hidden required value. The submission gate rejects a required result without commitment and checks browser-invalid required controls, so clicking a matching menu option alone does not clear the failure. This local fixture does not establish complete application success, OTP passage, all-country or all-ATS behavior, multi-select behavior, or the historical cause of unrelated failures.
