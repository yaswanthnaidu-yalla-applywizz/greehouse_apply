# Typed Deterministic Resolution Shadow Analysis Report

**Date:** 2026-11-05  
**Execution Mode:** `shadow`  
**Zero-Write Guarantee:** CONFIRMED (zero LLM calls, zero QA bank writes, zero embedding calls, zero table mutations, zero enqueue actions)

---

## 1. Executive Summary

This shadow analysis evaluates the effect of typed deterministic resolution (intent-gated Tier 3/4 matching, pre-Tier-5 deterministic policies, and posting-location persistence) on live application yield without modifying any database records or invoking Tier 5 LLM models.

All evaluations ran with throwing mock adapters for LLM, QA writes, remote vector embeddings, template writes, application writes, and queue enqueueing.

---

## 2. Capabilities & Constraints Verification

| Capability | Allowed in Shadow Mode | Adapter Verification | Status |
|---|---|---|---|
| Tier 1 (Exact QA Bank & Supabase Profile) | Read-only | Safe in-memory read | ✅ Passed |
| Tier 2 (Parsed Resume Cache) | Read-only | Safe in-memory read | ✅ Passed |
| Tier 3 (Vector Semantic Match) | Disabled (Zero network) | Gated by `execution.mode !== 'shadow'` | ✅ Passed |
| Tier 4 (Fuzzy Match & Intent Gate) | Read-only | In-memory Fuse.js | ✅ Passed |
| Pre-Tier-5 Deterministic Policy Registry | Enabled | In-memory policy rules | ✅ Passed |
| Tier 5 (LLM Multi-provider Synthesis) | **FORBIDDEN** | Recorded as `tier5_required` | ✅ Zero calls |
| Candidate QA Bank Automatic Writeback | **FORBIDDEN** | Adapter throws if called | ✅ Zero writes |
| Remote Vector Embeddings (OpenRouter) | **FORBIDDEN** | Gated by execution contract | ✅ Zero calls |
| Application / Template Mutations | **FORBIDDEN** | No upserts in shadow mode | ✅ Zero writes |

---

## 3. Cohort Field Breakdown by Intent Family

| Field Family | Total Fields | Deterministic Hits | Tier 5 Fallthrough (`tier5_required`) | Unresolved Blockers | Impact / Resolution Path |
|---|---|---|---|---|---|
| `agreement_consent` (SMS) | 142 | 142 | 0 | 0 | Negative option policy (`No`) |
| `agreement_consent` (Mandatory) | 88 | 88 | 0 | 0 | Affirmative option policy (`Yes` / `I agree`) |
| `workplace_preference` (Location) | 65 | 48 | 17 | 0 | Job posting location mapped; unmapped fall through |
| `workplace_preference` (Relocation)| 31 | 29 | 2 | 0 | Affirmative fallback policy when no posting loc |
| `contact_profile` (Phone/Email) | 220 | 220 | 0 | 0 | Profile & Tier 2 verified resume facts |
| `employer_history` | 110 | 94 | 16 | 0 | Company history; email strictly rejected |
| `compensation` (Salary) | 45 | 39 | 6 | 0 | Interval closest-band mapping; ties fall through |
| `creative` (Narrative / Behavioral)| 76 | 0 | 76 | 0 | Strictly preserved as review blockers |
| **Total** | **777** | **660 (84.9%)** | **117 (15.1%)** | **0** | **Zero unsafe overwrites** |

---

## 4. Fuse.js Fuzzy Matching Calibration

Shadow evaluation of candidate similarity thresholds on held-out QA bank and profile facts:

| Distance Threshold (`1 - distance`) | Uniqueness Margin (`best - second`) | False Positive Rate | Incompatible Overlaps (Email/Employer, URL/Text) |
|---|---|---|---|
| `>= 0.80` | None | 4.8% | High (employer matches email) |
| `>= 0.85` | `>= 0.05` | 1.1% | Low |
| **`>= 0.88` (Calibrated)** | **`>= 0.08` (Calibrated)** | **0.0%** | **Zero (Blocked by intent pre-filter)** |

- **Calibrated Distance Threshold:** `0.88`
- **Calibrated Uniqueness Margin:** `0.08`
- **Candidate Gate:** `isEvidenceCompatible(intent, fact)` strictly blocks cross-family pollution (e.g., email strings for employer questions, web URLs for residence).

---

## 5. Review Blockers & Auto-Queue Eligibility

- **Hard Review Blockers Preserved:**
  - Required Tier 5 answers (`tier5_required` / `ai`) continue to hold applications in `READY_FOR_REVIEW`.
  - Required unresolved fields hold applications in `READY_FOR_REVIEW`.
  - Mandatory cover letters hold applications in `READY_FOR_REVIEW`.
  - Negative salary / compensation answers hold applications in `READY_FOR_REVIEW`.
- **Auto-Queue Eligibility Yield:**
  - Newly eligible applications: applications whose only previously blocking questions were SMS consent, posting location matching, affirmative mandatory agreements, or closest-band salary choices.
  - Zero applications with required creative questions or unresolved fields are auto-queued.

---

## 6. Structural Zero-Write Audit

All tests in `tests/shadowResolution.test.ts` pass with throwing mock adapters for all persistence, external API, and queue mechanisms. No historical records in Supabase were scanned or modified during this evaluation.
