# Task 4 report — delayed embedded Greenhouse frame

## Change

Added `waitForEmbeddedGreenhouseApplicationUrl(page, timeoutMs)`, which checks the direct Greenhouse application matcher while polling frame URLs for at most the provided duration. `scanSingleUrl` polls for up to 1,000 ms only when no app frame is already present and a non-Greenhouse parent page contains a form. If no direct Greenhouse application frame appears, the existing parent extraction and closed-job behavior remain in place.

## RED / GREEN

- RED: before implementation, `node --import tsx --test tests/embeddedGreenhouseFrameScan.test.ts` failed at module loading because the requested wait helper was not exported.
- GREEN: `node --env-file='C:\Users\yaswa\Dev\greehouse_apply\.env' --import tsx --test tests/embeddedGreenhouseFrameScan.test.ts` — 4 tests passed: immediate frame, delayed frame, no frame with a generic parent form, and a delayed-frame scanner replay that extracts the GED field from the application page.
- GREEN: `node --env-file='C:\Users\yaswa\Dev\greehouse_apply\.env' node_modules/vitest/vitest.mjs run tests/closedJobNoEmbeddedForm.test.ts` — 7 tests passed.

## Walker-Miller live probe

Ran the diagnostic-only `walker-miller-probe.mjs` against `https://wmenergy.com/careers/position/5281483007?gh_jid=5281483007`. It completed without submitting. The page currently resolves to `https://wmenergy.com/careers/position/?gh_jid=5281483007`; the visible page is a general Walker-Miller careers page with a newsletter form and a Vimeo iframe, no Greenhouse application frame, and no GED field. The scanner returned zero fields and `isExpired: true`. Therefore the live replay does not verify the delayed embedded application fix; the current page did not expose the application frame during the probe.

## Scope

The implementation only recognizes HTTP(S) URLs on `greenhouse.io` hosts with a direct application path. The wait is bounded to one second and only applies to candidate external parent pages. No other ATS domains or question-cap changes were added. No application was submitted. Typecheck was not run because the Task 4 brief only requires the named focused tests.

## Review round 1

- RED: the hostile URL `https://attacker.example/?next=https://boards.greenhouse.io/embed/job_app?...` was returned as an application URL, and a direct Greenhouse job page called the polling delay 10 times.
- GREEN: `node --env-file='C:\Users\yaswa\Dev\greehouse_apply\.env' --import tsx --test tests/embeddedGreenhouseFrameScan.test.ts` — 5 tests passed, including delayed external-parent detection and zero polling calls on a direct Greenhouse job page.
- GREEN: `node --env-file='C:\Users\yaswa\Dev\greehouse_apply\.env' node_modules/vitest/vitest.mjs run tests/closedJobNoEmbeddedForm.test.ts` — 9 tests passed, including hostile-host and non-application-path rejection.
- Frame URL acceptance now parses the URL and requires an HTTP(S) scheme, a `greenhouse.io` hostname or subdomain, and the `/job_app` or `/embed/job_app` path. Delayed polling runs only when no direct app frame is already present and a non-Greenhouse parent page contains a form.
