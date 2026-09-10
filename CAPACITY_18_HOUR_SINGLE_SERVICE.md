# 18-Hour Capacity — Single Service, Max 3 Workers

**Scope:** One Railway service, API + embedded queue (`ENABLE_QUEUE_WORKER=true`, **`WORKER_CONCURRENCY` max 3** per `queueWorker.ts`), **100% OTP**, one Zoho Playwright session (one OTP lock per process), forms **≤ 23 fields**.

**Optimizations assumed (no extra services, no 4th worker):** warm Supabase profiles + QA bank, incremental scan (skip known templates), scan with **3** workers when you run prep manually, `pollInterval` **1000 ms**, fast operator skim (~45–60 s/app). **Parallel / incremental answer resolve** is listed separately where it changes prep.

**Not in scope:** 5-service layout, 9 workers, paid 8 GB single box — see [`CAPACITY_DEPLOYMENT_REPORT.md`](CAPACITY_DEPLOYMENT_REPORT.md).

---

## Throughput reference (application)

| | ~Minutes / job | ~Jobs / hour (3 workers) |
|---|---------------:|---------------------------:|
| Typical | 2.8–3.2 | **~52–55** |
| Tuned | 2.6–3.0 | **~55–60** |

**Planning rate for 18 h apply:** **~55 jobs/h** → **18 × 55 ≈ 990** applications.

```text
applications_in_apply_window ≈ hours × 55   (conservative)
applications_in_apply_window ≈ hours × 60   (optimistic)
```

**60 operators** do not limit drain speed; they only control how fast rows become `QUEUED`. Enqueueing **~1,000** apps across 60 people (~17 each) takes **~15–25 min** at skim speed.

---

# 1. Prep time (what fits in **18 hours** of *prep only*)

Prep = ingest → segregate → **scan new URLs** → **answer resolve** → operators approve (human step, parallel across CAs).

Prep does **not** use the 3 submit workers unless you run them on the same box at the same time (not recommended on 1 GB). Submit workers are irrelevant to **prep duration**.

## 1.1 Prep duration vs workload (current resolver: mostly serial)

| Applications to make `READY_FOR_REVIEW` | New URLs to scan (~) | Scan (3 workers) | Resolve (serial, warm bank) | Approve (60 CAs, skim) | **Prep total** |
|----------------------------------------:|---------------------:|-----------------:|----------------------------:|-----------------------:|---------------:|
| **300** | ~25–50 | ~5–15 min | ~45–90 min | ~10–15 min | **~1–2 h** |
| **600** | ~50–90 | ~10–25 min | ~1.5–3 h | ~15–25 min | **~2–3.5 h** |
| **1,000** | ~70–120 | ~15–35 min | ~2.5–5 h | ~20–35 min | **~3–6 h** |
| **1,500** | ~100–180 | ~20–45 min | ~4–7 h | ~25–45 min | **~5–8 h** |
| **3,000** | ~150–250 | ~25–60 min | **~4–8 h** | ~40–75 min | **~6–10 h** |

With **parallel resolve + per-candidate cache** (code not default today), resolve for **3,000** apps often drops to **~1–2.5 h** → **prep total ~2–4 h** for a full-sized wave.

## 1.2 “What can we prep in **18 hours**?” (prep-only budget)

If the clock is **only** prep (no application drain), 18 h is almost never the limit for normal waves — you can prep **full 3,000** applications in **~6–10 h** (serial resolve) or **~2–4 h** (parallel resolve) before operators approve.

| Goal | Fits in 18 h prep-only? |
|------|-------------------------|
| **3,000** apps `READY_FOR_REVIEW` | **Yes** (well under 18 h) |
| **Larger** (e.g. 5,000+ assignments) | **Yes**, until resolve/scan dominates; estimate linearly from table above |

**Practical prep cap in 18 h (serial resolve):** on the order of **~4,000–5,000** applications if scan stays incremental and URL count stays in the low hundreds (otherwise resolve dominates past **~8–12 h**).

---

# 2. Apply time (what fits in **18 hours** of *application only*)

Application = rows in `QUEUED` → `runLiveSubmit` → OTP → `APPLIED` / `FAILED`, **3** concurrent browsers, **1** Zoho lock.

## 2.1 Applications completable in 18 h (submit drain)

| Rate | **18 h** applications |
|------|----------------------:|
| **~55 / h** (planning) | **~990** |
| **~60 / h** (optimistic) | **~1,080** |
| **~50 / h** (bad OTP day) | **~900** |

**Round numbers:** plan **~900–1,000** applications; stretch **~1,050** if jobs run fast and few `FAILED`/retries.

## 2.2 Candidates and jobs (apply window only)

| Jobs per candidate | **~1,000** apps @ 18 h apply | **~900** apps |
|--------------------|----------------------------:|--------------:|
| **10** | **~100** candidates | **~90** |
| **7** | **~143** | **~129** |
| **5** | **~200** | **~180** |
| **3** | **~333** | **~300** |

Operators: **60 users** is fine; **~1,000** apps ≈ **~17 approvals each** (~15–20 min enqueue wall clock).

---

# 3. Combined ( **18 hours** total: prep + approve + apply )

One clock for the whole wave. Submit workers run **after** (or overlapping tail of) prep; approve usually sits between prep and heavy drain.

## 3.1 Serial resolve (current code path)

| Phase | Time used (example: **~1,000** apps) | Time used (example: **~3,000** apps) |
|-------|--------------------------------------|--------------------------------------|
| Prep (scan + resolve) | **~3–6 h** | **~6–10 h** |
| Approve (60 skim) | **~0.3–0.6 h** | **~0.7–1.3 h** |
| **Remaining for apply in 18 h** | **~11–15 h** | **~7–11 h** (often **not enough** for full 3k) |
| **Applications finished in 18 h total** | **~600–850** | **~350–650** (partial 3k wave) |

**Combined 18 h — planning targets (serial resolve):**

| Target | **~Applications completed end-to-end** | **~Candidates @ 10 jobs** |
|--------|---------------------------------------:|---------------------------:|
| **Conservative** | **~550–700** | **~55–70** |
| **Typical** | **~650–850** | **~65–85** |
| **Strong prep + fast apply** | **~800–900** | **~80–90** |

**Full 3,000 in 18 h combined:** **No** — apply alone needs **~55 h** at 3 workers; even with **0** prep, 18 h apply caps **~1,000** jobs.

## 3.2 With parallel resolve (optimized prep, still 1 service / 3 workers)

Prep shrinks; more of the 18 h goes to apply.

| Phase | **~1,000** apps | **~1,100** apps (≈ max for 18 h) |
|-------|----------------|----------------------------------|
| Prep + approve | **~1.5–3 h** | **~2–3.5 h** |
| Apply (remainder) | **~15–16.5 h** | **~14.5–16 h** |
| **Completed in 18 h total** | **~900–1,000** | **~1,000–1,100** |

**Combined 18 h — with parallel resolve (still 3 submit workers):**

| | Applications completed | Candidates @ 10 jobs |
|---|------------------------:|---------------------:|
| **Planning** | **~900–1,000** | **~90–100** |
| **Stretch** | **~1,050** | **~105** |

## 3.3 Combined summary table

| Budget | Prep + approve (serial) | Apply capacity in leftover time | **~Total apps in 18 h** |
|--------|-------------------------|--------------------------------|-------------------------:|
| **18 h all-in** | **~4–8 h** for ~1k ready | **~10–14 h** × 55/h | **~650–850** |
| **18 h all-in** | **~2–3.5 h** for ~1k ready (parallel resolve) | **~14–16 h** × 55/h | **~900–1,050** |
| **18 h apply-only** | (done earlier) | **18 h** × 55/h | **~990–1,000** |

---

# 4. One-page cheat sheet

| Question | Answer (1 service, 3 workers, **18 h**) |
|----------|----------------------------------------|
| Max **apply-only** in 18 h? | **~900–1,000** applications (**~90–100** candidates × 10 jobs) |
| Max **combined** (today’s resolve)? | **~650–850** applications (**~65–85** candidates × 10 jobs) |
| Max **combined** (+ parallel resolve)? | **~900–1,050** applications (**~90–105** candidates × 10 jobs) |
| Can we prep **3,000** in 18 h? | **Yes** (prep-only); **cannot apply all 3,000** in the same 18 h |
| 60 operators? | **OK** — size **applications**, not operator count |

---

# 5. Related docs

- [`CAPACITY_DEPLOYMENT_REPORT.md`](CAPACITY_DEPLOYMENT_REPORT.md) — §1 baseline timings, multi-service and paid options  
- [`capacity_and_timing_math.md`](capacity_and_timing_math.md) — formulas and CSV link reuse  
- [`round_robin_queue_scheduler.md`](round_robin_queue_scheduler.md) — queue semantics  

**Document date:** 2026-09-10
