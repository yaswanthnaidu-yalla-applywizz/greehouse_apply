# Task 4 report — delayed embedded Greenhouse frame

## Change

Added `waitForEmbeddedGreenhouseApplicationUrl(page, timeoutMs)`, which checks the existing direct Greenhouse URL matcher while polling frame URLs for at most the provided duration. `scanSingleUrl` now waits up to 1,000 ms after `DOMContentLoaded` before deciding whether to navigate to the ATS application. If no direct Greenhouse application frame appears, the existing parent extraction and closed-job behavior remain in place.

## RED / GREEN

- RED: before implementation, `node --import tsx --test tests/embeddedGreenhouseFrameScan.test.ts` failed at module loading because the requested wait helper was not exported.
- GREEN: `node --env-file='C:\Users\yaswa\Dev\greehouse_apply\.env' --import tsx --test tests/embeddedGreenhouseFrameScan.test.ts` — 4 tests passed: immediate frame, delayed frame, no frame with a generic parent form, and a delayed-frame scanner replay that extracts the GED field from the application page.
- GREEN: `node --env-file='C:\Users\yaswa\Dev\greehouse_apply\.env' node_modules/vitest/vitest.mjs run tests/closedJobNoEmbeddedForm.test.ts` — 7 tests passed.

## Walker-Miller live probe

Ran the diagnostic-only `walker-miller-probe.mjs` against `https://wmenergy.com/careers/position/5281483007?gh_jid=5281483007`. It completed without submitting. The page currently resolves to `https://wmenergy.com/careers/position/?gh_jid=5281483007`; the visible page is a general Walker-Miller careers page with a newsletter form and a Vimeo iframe, no Greenhouse application frame, and no GED field. The scanner returned zero fields and `isExpired: true`. Therefore the live replay does not verify the delayed embedded application fix; the current page did not expose the application frame during the probe.

## Scope

The implementation only recognizes the existing direct Greenhouse application URL patterns. The wait is bounded to one second, and no question cap or ATS-domain rules were changed. No application was submitted. Typecheck was not run because the Task 4 brief only requires the named focused tests.
