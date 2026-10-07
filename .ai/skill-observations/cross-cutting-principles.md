# Cross-Cutting Principles

These are patterns observed across multiple skills and sessions that apply broadly.
Seeded from project history — task-observer will grow this over time.

---

## Principle 1: State Before Action

**Before writing to any DB or file, read the current state first.**

Applies to: any migration, any upsert, any resolver change, any schema edit.
Evidence: Multiple bugs came from blind writes that ignored existing rows. The idempotent upsert pattern exists for this reason.

---

## Principle 2: Supabase Is the Only Source of Truth

**Never introduce local file state as a fallback or cache in production code.**

Local `output/`, `cache/`, `resumes/` dirs exist for local dev/testing only.
Any code path that reads from local JSON as a fallback is a V1 regression.
Evidence: V1→V2 migration was entirely about eliminating local file state.

---

## Principle 3: Tier Ordering Is a Contract, Not a Suggestion

**The 5-tier resolver must execute in order and short-circuit on first hit.**

Skipping tiers, reordering them, or calling Tier 5 (LLM) before Tier 1 is a correctness and cost bug.
Evidence: LLM write-back to qa_bank only works if Tier 1 is always checked first on subsequent runs.

---

## Principle 4: Fingerprint Is the Identity of a Question

**Never use raw label strings as keys for question answers.**

All answer storage and lookup must go through `fingerprint.ts` → SHA-256(label|type) → 16-char hex.
Evidence: Label strings are unstable across Greenhouse form renders; fingerprints are stable.

---

## Principle 5: Playwright Changes Must Work in Both Modes

**Any change to scanner, form filler, or submission must be tested mentally against headless AND headful.**

`RAILWAY_ENV=true` disables headful. Code that assumes a visible browser will silently fail in prod.
Evidence: This constraint is why dry-run and live-submit have separate code paths.

---

## Principle 6: Write-Back Compounds Value Over Time

**LLM and manual answers must always be written back to `candidate_qa_bank`.**

An answer that isn't written back costs LLM money again on the next run for the same candidate.
Evidence: The entire Tier 1 hit rate improvement depends on consistent write-back.

---

## Principle 7: Guarded Probes & Verifications

**Shell probes that return 0 or empty must not be treated as findings without confirming the probe itself ran correctly (quotes/escapes intact, right tool). HTML/JSX surfaces without static typechecking require explicit DOM scope checks; token presence is not shape correctness.**

Applies to: shell-based verification probes, test running, unchecked HTML/JSX frontend surfaces.
Evidence: #0005 (probes rewritten in transit via shell quoting), #0016 (token presence vs DOM nesting/shape), #0018 (per-surface verification blind spots).

---

## Principle 8: Secondary Passes Must Reuse Invariant Gates

**Any backfill, safety-net, or secondary pass must enforce the same FK/eligibility checks as the primary pass. No bypass.**

Applies to: ingest backfills, queue recovery passes, reconcilers, and secondary data processors.
Evidence: #0013 (secondary CSV ensure pass bypassed parent profile existence gate, violating FK constraints).

---

## Principle 9: Code Context Governs Idiom Safety

**Before applying a spec sketch or copying a local pattern, read the enclosing try/catch and control-flow. A fix name referencing a nonexistent mechanism, or an idiom transplanted into different error-fallthrough semantics, must be caught at planning time, not after a bad diff.**

Applies to: code refactoring, bug fixes from prompt specs, applying idioms across distinct callers.
Evidence: #0003 (spec prescribing nonexistent mechanisms or already-applied changes), #0017 (convention copied into different error/catch control flow).
