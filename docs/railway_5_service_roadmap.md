# Railway 5-Service Roadmap (Elastic Workers)

Your model: **five services**, one **API + 1 submitter**, one **hybrid prep pool (2–3 workers)** that does scan/resolve when needed, three **submit-only pools**, and **any idle worker anywhere** should drain the global `QUEUED` backlog.

See also: [`capacity_and_timing_math.md`](../capacity_and_timing_math.md).

---

## 1. The five services (your layout)

| # | Role | Workers | Primary work | When idle |
|---|------|--------:|--------------|-----------|
| **S1** | **Main app** + light submit | **1** | HTTP API, dashboard, enqueue | That **1** worker polls **submit queue** |
| **S2** | **Hybrid prep + spillover submit** | **2–3** | Scan (new URLs), segregate, resolve | Same workers poll **submit queue** |
| **S3** | Submit pool | **2–3** | `runLiveSubmit` only | Always on submit queue |
| **S4** | Submit pool | **2–3** | Submit only | Always on submit queue |
| **S5** | Submit pool | **2–3** | Submit only | Always on submit queue |

**Max parallel browsers (all idle, no prep):**  
`1 + (2–3) + (2–3) + (2–3) + (2–3) = **9–13**` submit workers.

**During heavy prep on S2:** only **S1 + S3 + S4 + S5** submit ( **7–10** workers ) until S2 finishes scan/resolve; then S2 joins the drain.

```text
                    ┌──────────────────────────────────┐
                    │ S1: Express + 1× queue worker    │
                    │     ENABLE_QUEUE_WORKER=1        │
                    └───────────────┬──────────────────┘
                                    │
    ┌───────────────────────────────┼───────────────────────────────┐
    │                               │                               │
    ▼                               ▼                               ▼
┌─────────────┐              ┌─────────────┐              ┌─────────────┐
│ S2 Hybrid   │              │ S3 Submit   │   ...        │ S5 Submit   │
│ 2–3 slots   │              │ 2–3 workers │              │ 2–3 workers │
│ prep OR     │              │ daemon only │              │ daemon only │
│ submit      │              └──────┬──────┘              └──────┬──────┘
└──────┬──────┘                     │                            │
       │                            └────────────┬───────────────┘
       │                                         ▼
       │                          Supabase: status = QUEUED
       │                          get_next_queued_application()
       │                          FOR UPDATE SKIP LOCKED
       └────────────────────────────────────────┘
```

---

## 2. What already works without new code

### Cross-service “idle → submit”

**S3, S4, S5** (and **S1’s** embedded daemon) already behave as you want:

- Each process runs `SubmissionQueueDaemon` loops.
- Each loop calls `getNextQueuedApplicationForRoundRobin()` → atomic dequeue.
- If the queue is empty, workers **sleep** (`pollIntervalMs`, default 2000 ms) and retry.
- If the queue has jobs, **every free worker on every service** pulls the next row.

No coordination between Railway services is required: **Postgres is the scheduler.**

So: *“when there’s workers free in the complete submitter services, they submit”* — **yes, today.**

### What does **not** work yet

**S2 hybrid:** *“2–3 workers scan and stuff, and when free they submit too”* in **one** service.

Today the repo has **two separate engines**:

| Engine | Entry | Work |
|--------|--------|------|
| Scanner | `PlaywrightScanner` / `runScan.ts` | URL DOM scrape |
| Resolver | `AnswerResolver` / `runResolver.ts` | Fill `resolved_fields` |
| Submitter | `SubmissionQueueDaemon` / `queueWorker.ts` | `runLiveSubmit` |

They do **not** share a worker pool. A scanner worker cannot “flip” to submit when idle without **new orchestration code** (see §5).

---

## 3. How to configure each service (current repo)

Same Docker image everywhere; **start command + env** differ.

### S1 — Main app + 1 submitter

| Setting | Value |
|---------|--------|
| Start | `node dist/server/index.js` |
| Health | `/api/health` |

```bash
ENABLE_QUEUE_WORKER=true
WORKER_CONCURRENCY=1

# API, auth, Supabase — full production env
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
JWT_SECRET=...

# Zoho on this process (1 session; 1 worker shares it for OTP)
ZOHO_CONNECTOR_USER=...
ZOHO_CONNECTOR_PASS=...
ZOHO_CONNECTOR_URL=...
```

`WORKER_CONCURRENCY` is read in `server/index.ts` when embedding the daemon (not on standalone `queueWorker.js`).

### S3, S4, S5 — Submit-only (all workers submit)

| Setting | Value |
|---------|--------|
| Start | `node dist/submitter/queueWorker.js --workers=3 --interval=1000` |
| `ENABLE_QUEUE_WORKER` | unset / false (no Express) |

```bash
NODE_ENV=production
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
ZOHO_CONNECTOR_*=...    # one Zoho session per service (3 more OTP pipelines)
```

Use `--workers=2` on **1 GB** RAM if you see OOM.

**Each of S1, S3, S4, S5** = separate Node process → up to **4 Zoho browsers** if all init Zoho (S2 adds a 5th when it submits).

### S2 — Hybrid (today: pick one mode per deploy)

Until §5 is built, run **either** prep **or** submit on S2, not both at once:

**Mode A — Prep morning (same day)**

```bash
# One-shot or cron; uses scanner pool, not queue daemon
node dist/scanner/runScan.js --input=/data/wave.csv --workers=3
node dist/resolver/runResolver.js --candidates=./output/candidate_segments.json --scanned=./output/scanned_jobs.json
```

`WORKER_POOL_SIZE=3` or `--workers=3` for scan only.

**Mode B — Spillover submit (after prep)**

```bash
node dist/submitter/queueWorker.js --workers=3 --interval=1000
```

**Ops workaround for “idle → submit” on S2:** Railway cron or manual: run prep job → on success, **redeploy S2** with submit start command (or two-phase script). S3–S5 + S1 already submit during prep.

---

## 4. Optimize prep vs application (unchanged targets)

### Prep — target **~1.5–2.5 h** (mostly **S2** + Supabase)

| Tactic | Where |
|--------|--------|
| Scan **only new** canonical URLs | S2 prep job; skip rows in `scanned_job_templates` |
| **3–5** scanner workers | `runScan --workers=5` on S2 during prep window |
| Warm profiles + QA bank | Supabase (no ApplyWizz batch API) |
| Parallel resolve per candidate | **Code** — see §5 |
| Incremental skip unchanged apps | **Code** |

While S2 runs prep, **S1 + S3 + S4 + S5** can already drain `QUEUED` if operators enqueue early (usually you prep before approve).

### Application — target **~15–28 h** for 3,000 @ 100% OTP

| Tactic | Where |
|--------|--------|
| **9–13** submit workers when S2 is in submit mode | S1×1 + S2×2–3 + S3–5×2–3 |
| **4–5 Zoho sessions** (one per service that submits) | S1, S2 (when submitting), S3, S4, S5 |
| `--interval=1000` | All daemons |
| 3 min OTP → `FAILED` | **Code** (product rule) |
| Stop services when queue empty | Railway scale-to-zero / stop S2–S5 |

**Rough math (all services submitting, ~2.2 min/job):**

```text
workers = 10 (midpoint of 9–13)
hours ≈ 3000 / (10 × (60/2.2)) ≈ 3000/273 ≈ 11 h   (optimistic)

workers = 9, 2.5 min/job → ~3000/(9×24) ≈ 14 h
workers = 9, 3.0 min/job → ~3000/(9×20) ≈ 17 h
```

Faster than the old **3-worker / ~55 h** design because you have **~3×** workers and **~4×** Zoho processes (S1+S3+S4+S5, plus S2 when in submit mode).

---

## 5. What to build for true S2 hybrid (“prep when needed, else submit”)

Add a **single supervisor per service** (start with S2) that owns **N browser slots**:

```text
loop forever:
  if prep_job_pending (CSV wave / scan queue / resolve queue):
    slot ← acquire
    run scan OR resolve task
    release
  else:
    slot ← acquire
    app ← getNextQueuedApplicationForRoundRobin()
    if app: runLiveSubmit(app)
    else: sleep(pollInterval)
    release
```

**Priority:** prep tasks only when `prep_job_pending` (flag in DB, Redis, or file); otherwise behave like S3–S5.

**Optional:** same supervisor on S1’s single worker is usually wrong (keep S1 for API + 1 submit only). **S3–S5** stay submit-only.

**Files to extend:** new `src/orchestrator/elasticWorker.ts` (or extend `queueWorker.ts` with `--mode=hybrid`), call existing scanner/resolver/submitter modules.

Until this ships, use **S2 Mode A → Mode B** redeploy (§3).

---

## 6. Daily timeline (same-day)

| Phase | Services active | Work |
|-------|-----------------|------|
| Prep | **S2** scan/resolve; **S1** API up | New CSV → templates + `READY_FOR_REVIEW` |
| Optional overlap | **S1, S3–S5** | Submit if anything already `QUEUED` |
| Approve | **S1** | 60 CAs enqueue |
| Drain | **S1, S2 (submit mode), S3–S5** | All idle slots pull `QUEUED` |
| Done | Stop **S2–S5** or scale to 0 | Keep **S1** |

---

## 7. Checklist

**Shared**

- [ ] Migration `005_round_robin_queue.sql` applied  
- [ ] Same `SUPABASE_*` on all five services  

**S1**

- [ ] `ENABLE_QUEUE_WORKER=true`, `WORKER_CONCURRENCY=1`  
- [ ] `ENABLE_QUEUE_WORKER=false` on S3–S5 (they use standalone daemon only)  

**S3–S5**

- [ ] `node dist/submitter/queueWorker.js --workers=2|3`  
- [ ] Zoho env on each  

**S2**

- [ ] Prep: `runScan` + `runResolver` with `--workers=3–5`  
- [ ] After prep: submit daemon **or** hybrid supervisor (§5)  

**Elastic behavior**

- [ ] **Across S1,S3–S5:** works today via shared queue  
- [ ] **On S2:** needs §5 or redeploy workaround  

---

## 8. Implementation backlog

| Item | Status |
|------|--------|
| Multi-service submit dequeue (`SKIP LOCKED`) | Done |
| S1 embedded daemon (`WORKER_CONCURRENCY`) | Done |
| Standalone daemon (`--workers=`) | Done |
| S2 unified prep/submit pool | **Not built** — §5 |
| Zoho `init()` on standalone daemon boot | Recommended |
| Parallel / incremental resolver | Recommended for prep time |
| OTP 3 min → `FAILED` | Product rule — implement |
