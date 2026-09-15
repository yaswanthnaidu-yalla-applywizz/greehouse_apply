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
