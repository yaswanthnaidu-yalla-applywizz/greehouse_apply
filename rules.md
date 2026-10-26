never hardcode secrets.

\## 1. Think Before Coding



\*\*Don't assume. Don't hide confusion. Surface tradeoffs.\*\*



Before implementing:

\- State your assumptions explicitly. If uncertain, ask.

\- If multiple interpretations exist, present them - don't pick silently.

\- If a simpler approach exists, say so. Push back when warranted.

\- If something is unclear, stop. Name what's confusing. Ask.



\## 2. Simplicity First



\*\*Minimum code that solves the problem. Nothing speculative.\*\*



\- No features beyond what was asked.

\- No abstractions for single-use code.

\- No "flexibility" or "configurability" that wasn't requested.

\- No error handling for impossible scenarios.

\- If you write 200 lines and it could be 50, rewrite it.



Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.



\## 3. Surgical Changes



\*\*Touch only what you must. Clean up only your own mess.\*\*



When editing existing code:

\- Don't "improve" adjacent code, comments, or formatting.

\- Don't refactor things that aren't broken.

\- Match existing style, even if you'd do it differently.

\- Don't use redacted or sanitized tool output as literal patch context. If a patch doesn't match, re-read the source and anchor it on nearby non-sensitive text; run a focused check to verify the intended behavior.

\- If you notice unrelated dead code, mention it - don't delete it.



When your changes create orphans:

\- Remove imports/variables/functions that YOUR changes made unused.

\- Don't remove pre-existing dead code unless asked.



The test: Every changed line should trace directly to the user's request.



\## 4. Goal-Driven Execution



\*\*Define success criteria. Loop until verified.\*\*



Transform tasks into verifiable goals:

\- "Add validation" → "Write tests for invalid inputs, then make them pass"

\- "Fix the bug" → "Write a test that reproduces it, then make it pass"

\- "Refactor X" → "Ensure tests pass before and after"



For multi-step tasks, state a brief plan:

```

1\. \[Step] → verify: \[check]

2\. \[Step] → verify: \[check]

3\. \[Step] → verify: \[check]

```



Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.



\---



\*\*These guidelines are working if:\*\* fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.



## 5. Protect the Success Rate

**When failure rate is ≤ 25% and caused by data faults or retryable conditions — do not touch the code.**

- Diagnose *why* failures occurred before any code change is proposed.
- Classify failures: data fault (wrong/missing input), retryable (OTP timeout, transient network), or genuine code bug.
- Only code bugs justify code changes. Data faults and retryables are fixed by data correction or operator retry — never by editing the resolver, form filler, or submission engine.
- If a change is proposed to fix a minority failure class, explicitly state the estimated risk to the majority success class. If that risk is non-zero and unquantifiable, do not make the change.
- **Precedent:** An 80% success rate was destroyed by editing code to fix a 16% location-error (data fault) failure class. This must not happen again.
