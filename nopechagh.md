# Reduce unnecessary CAPTCHA encounters in ATS workflows

Research updated 18 November 2026. This replaces the earlier feasibility draft with sourced methods and explicit limits. It is research, not an implementation plan or a measured improvement.

User requirement update: no human-in-the-loop workflow. Stop an application that requires interactive CAPTCHA, record the reason clearly, and continue other applications. Greenhouse changes are excluded. See the [curated Ashby, Lever, and Rippling plan](docs/superpowers/plans/2026-11-18-ats-captcha-reduction.md) and its linked requirements for the current proposal.

The priorities are fewer unnecessary page visits, respectful traffic budgets, reliable browser execution, and clear terminal records for actual challenges. No documented method guarantees CAPTCHA-free automation. Employer configuration remains outside this application's control.

## Corrections to the earlier draft

- The claims of 100% prevention and 100% reliable human handling were unsupported.
- The reviewed documentation does not establish that every solver token fails because it is bound to the originating TLS connection.
- A loading spinner does not prove that fingerprint detection caused the failure.
- Widget presence, background verification, interactive challenges, and widget errors are different states.
- The earlier cooldowns, keystroke intervals, mouse recipes, and Chrome-channel recommendations have no demonstrated CAPTCHA benefit here.
- Headful Chrome under Xvfb conflicts with the project's Railway headless constraint.

Project scope excludes automated CAPTCHA solving and bypass services. This research does not recommend fingerprint spoofing, hiding automation indicators, token injection, or switching proxies to work around a challenge. Submission stays Playwright-only. OTP and confirmation-email verification remain separate requirements.

## Methods to investigate

These are candidates for investigation. Expected CAPTCHA benefits are hypotheses unless explicitly documented. None establishes a defect in the current code.

### 1. Use supported public read APIs for discovery

Avoid a full browser visit when the ATS already publishes the required metadata.

| ATS | Supported read capability | Limit |
| --- | --- | --- |
| Greenhouse | Public Job Board GET endpoints provide listings and job details. A job request with `questions=true` can include configured application fields. | Verify the live form before submission. |
| Ashby | Public posting feed provides published job metadata and application URLs. | It is not a complete application-question schema. |
| Lever | Public Postings API provides lists, filters, pagination, and individual posts. | Custom questions are not exposed. DOM scanning remains necessary. |
| Rippling | No equivalent public read contract was verified in this research. | Do not invent a private endpoint as a replacement. |

Sources: [Greenhouse Job Board API](https://docs.greenhouse.io/job-board), [Ashby public posting API](https://developers.ashbyhq.com/docs/public-job-posting-api), and [Lever Postings API](https://github.com/lever/postings-api).

Fewer browser visits reduce traffic and browser work. A CAPTCHA reduction is an inference, not a vendor promise. A public API is not a fallback around an access denial. API-based submission remains outside this project's rules.

### 2. Deduplicate scans across candidates and overlapping runs

The repository already has URL deduplication and Supabase-backed templates. Inspect their coverage before adding anything.

Potential investigation targets include sharing a fresh job template across candidate rows, coalescing simultaneous scans, and avoiding repeated shortlink resolution. Preserve meaningful URL parameters. Establish freshness rules and verify required fields against the live form.

These are traffic-reduction proposals, not findings that existing caching is defective. Supabase remains authoritative. Do not restore legacy local JSON state.

### 3. Honor shared throttling signals

HTTP `429` means excessive requests. `Retry-After` accepts seconds or an HTTP date. A `503` can also carry that header. A server can count requests across identities or multiple servers, so independent worker sleeps may not respect its actual limit. Sources: [RFC 6585 section 4](https://www.rfc-editor.org/rfc/rfc6585.html#section-4) and [RFC 9110 section 10.2.3](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after).

For a future design, account for scanner and submitter traffic together where they share a host or provider budget. Prefer documented limits. No universal applications-per-minute threshold was verified.

Backoff means waiting. It does not authorize replaying an application. An uncertain post-click result requires investigation before another attempt.

### 4. Prevent repeated navigation and Apply attempts

Review existing application locks, queue ownership, and retry rules. Candidate safeguards include one active worker per application and durable evidence of whether Apply was clicked.

A lost response can leave an application submitted but unconfirmed. A second click risks a duplicate. Preventing duplicate applications is the primary reason for this method. Reduced repeated traffic is a plausible secondary benefit.

Do not reload or restart repeatedly after a human-verification block.

### 5. Keep required page dependencies working

Cloudflare identifies disabled JavaScript, unsupported browsers, unstable connectivity, and blocked scripts as possible causes of verification trouble. Source: [Cloudflare challenge troubleshooting](https://developers.cloudflare.com/cloudflare-challenges/troubleshooting/challenge-solve-issues/).

Before blocking resources for speed, verify that the rule preserves required ATS scripts, challenge resources, uploads, and form validation. Check normal DNS, TLS, and system-clock failures. This is a compatibility investigation, not proof that a particular CAPTCHA has that cause.

### 6. Maintain a supported browser runtime

Cloudflare recommends current supported browsers and provides a compatibility checker. Test upgrades in an authorized fixture or staging environment before production. Source: [Turnstile troubleshooting](https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/).

A different Chrome channel is not an established prevention method. Preserve Railway headless compatibility. Do not add flags to conceal automation.

### 7. Wait for actual form readiness

Playwright checks conditions such as visibility, stability, and enabled state before a click. Those checks do not establish upload completion, parsed-resume completion, or server acceptance. Source: [Playwright auto-waiting](https://playwright.dev/docs/actionability).

If a genuine code bug is reproduced, wait for the relevant upload, parse, field-commit, or validation state. Do not substitute arbitrary sleeps. Preserve existing correct filling behavior. No CAPTCHA benefit from simulated mouse paths or slow typing was established here.

### 8. Reduce avoidable idle time in an open form

Prepare truthful answers and files before navigation where the current workflow permits. Avoid leaving a form open while unrelated work runs.

Turnstile tokens expire after five minutes and are intended for single validation. Google's reCAPTCHA response tokens expire after two minutes and permit one verification. These are token lifetimes, not universal form-filling deadlines. The ATS controls token generation and refresh. Sources: [Turnstile validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) and [reCAPTCHA verification](https://developers.google.com/recaptcha/docs/verify).

Do not copy, pre-generate, or replay tokens. Use the site's normal verification flow.

### 9. Preserve ordinary session continuity

Within an authorized attempt, avoid unnecessary browser restarts and clearing ordinary page state. Keep candidate contexts isolated. Do not share authentication, clearance cookies, or verification tokens across candidates.

This is a continuity proposal. Persistent contexts require privacy, lifecycle, and crash-recovery review before adoption. No reduction in challenge frequency has been measured.

### 10. Diagnose network reliability before buying proxies

The earlier draft treated residential routing as automatically beneficial. Cloudflare explicitly documents that VPNs and proxies can interfere with Turnstile. Source: [Turnstile troubleshooting](https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/).

Investigate ordinary connection failures on the approved route. A broken route and a human-verification block are different conditions. Do not rotate addresses or providers in response to a challenge. This research authorizes no purchase or routing change.

### 11. Seek a supported integration from the site owner

For recurring legitimate workload, request written guidance about supported automation, traffic limits, and partner access. This is a proposed administrative route, not a claim that these vendors offer exemptions.

The site owner controls challenge configuration. Client-side changes cannot guarantee fewer prompts when human verification is required.

### 12. Stop challenged applications with clear records

When human interaction is required, stop that application and preserve evidence. Continue other applications. Do not create a manual verification queue or resume the application through a human-operated session.

Use the existing FAILED status with a structured challenge reason rather than inventing another status. Record stage, provider, submit-click state, timestamp, and screenshot reference when available. Do not retry a challenged application automatically.

## Classify failures before changing code

Repository rule 12 permits scanner, resolver, or submission code fixes only for demonstrated code bugs.

| Evidence | Initial classification | Action |
| --- | --- | --- |
| Wrong or missing candidate answer | Data fault | Correct candidate evidence through the normal review workflow. |
| `429`, temporary network failure, or outage | Retryable condition | Respect limits and preserve current retry policy. Investigate uncertain post-click outcomes. |
| Visible human verification | Human block | Stop that application, record the block, and continue others. This does not prove a code bug. |
| Invalid sitekey or unauthorized hostname | Site-owner configuration fault | Escalate with evidence. Client retries do not repair it. |
| Reproduced duplicate scan or double Apply caused by our code | Code bug | Propose a narrow fix with regression evidence and majority-success risk assessment. |
| Spinner without decisive evidence | Unknown | Collect diagnostics rather than assert detector rejection. |

No production failures were classified from live data in this research. No runtime change is ready for implementation based on this document alone.

## Distinguish challenges from errors

Record widget presence, background checks, visible human interaction, widget errors, throttling, uncertain submission, and confirmed acceptance separately.

Cloudflare distinguishes sitekey and hostname configuration errors from load failures and timeouts. A Private Access Token request returning `401` can be expected and is not by itself proof of a block. Sources: [Turnstile error codes](https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/) and [challenge troubleshooting](https://developers.cloudflare.com/cloudflare-challenges/troubleshooting/challenge-solve-issues/).

Do not use the earlier sample handler that treats iframe presence or token length as verification success. The normal ATS flow and application confirmation remain authoritative.

Collect diagnostic codes, timestamps, browser version, stage, and an appropriate screenshot. Avoid logging tokens, cookies, resumes, or candidate answers. Protect HAR files and screenshots because they may contain personal data.

## Measure fewer challenges without hiding failures

For a future authorized evaluation, report these together:

- Unique intended applications, started attempts, Apply clicks, and confirmed applications.
- Interactive challenges per started attempt, separated by ATS and employer.
- Widget errors and rate limits, counted separately from human challenges.
- Unconfirmed outcomes, duplicates, terminal challenge records, queue age, and completion time.
- Browser version, headless mode, worker configuration, evaluation window, and sample size.

Compare equivalent workloads. Lower CAPTCHA counts caused by skipped jobs, fewer attempts, or a stalled queue do not establish improvement. A dry run that aborts the final request cannot establish the challenge rate after server processing.

The local [Rippling report](docs/rippling.md) records blocked or unconfirmed outcomes and later diagnostic trials. Those observations do not establish a platform-wide failure rate or the detector's exact reasoning. No new employer submissions, challenge attempts, production reads, or billable provider tests were performed for this update.

## Follow-up investigation order

1. Establish challenge, error, and confirmed-success counts from existing authorized evidence.
2. Audit deduplication, template reuse, and overlapping worker behavior.
3. Check supported read-API use and compliance with rate-limit responses.
4. Investigate browser or dependency failures where evidence identifies them.
5. Verify terminal records and queue continuation for unavoidable challenges.

These are investigation priorities. They do not establish bugs or authorize changing a working majority path. No reviewed source supports a percentage CAPTCHA reduction, universal cooldown, or guaranteed provider choice.
