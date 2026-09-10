# Capacity & Deployment Report — Prep vs Application Time

**Audience:** Operators and infra planning  
**Scenario:** 300 candidates × up to 10 jobs = **3,000** applications per wave; **60** concurrent operators; **100% OTP**; forms **≤ 23 fields** only; **new CSV each wave**  
**Reference data:** [`greenhouse_only_applywizz_prod(in).csv`](greenhouse_only_applywizz_prod(in).csv) — **5,437** assignments, **401** canonical unique job URLs (~**13.6** assignments per unique posting)  
**Related:** [`capacity_and_timing_math.md`](capacity_and_timing_math.md), [`docs/railway_5_service_roadmap.md`](docs/railway_5_service_roadmap.md), [`docs/capacity_deployment_report.md`](docs/capacity_deployment_report.md) (duplicate in `docs/`)

---

## Shared assumptions (all sections)

| Input | Value |
|--------|--------|
| Applications per wave (max) | **3,000** |
| New canonical URLs to scan (typical / high) | **~150–250** / **~300–400** |
| Submit queue | Supabase `QUEUED` + `get_next_queued_application()` (`SKIP LOCKED`) |
| OTP | Every application; Zoho Playwright reader (**one lock per Node process**) |
| Success criterion | **Web proof** → `APPLIED` = complete |
| Operator review | Fast skim (~**45–60 s**/app); one-by-one approve; **~50** apps per operator |

### Per-job time building blocks (application)

| Segment | Typical range |
|---------|----------------|
| Browser: navigate, fill, submit | **~75–120 s** |
| Zoho OTP read (per process, serialized inside service) | **~20–60 s** (up to **90 s** timeout) |
| OTP entry + verification | **~15–35 s** |
| Proof upload + worker poll gap | **~10–22 s** (**2 s** default poll) |
| **Total worker-busy** | **~2.5–4.0 min** / job |

### Throughput formula

```text
application_hours ≈ total_jobs / (effective_parallel_workers × (60 / avg_job_minutes))

prep_scan_minutes ≈ (new_unique_urls × 35) / (60 × scanner_workers)

prep_resolve_hours ≈ (applications × avg_seconds_per_app) / 3600   # single-threaded today
```

---

# Section 1 — Prep and application times **now** (current codebase & default ops)

This is the **baseline**: largely **one Railway service** running the API, optional **embedded queue** (`ENABLE_QUEUE_WORKER=true`, default **`WORKER_CONCURRENCY=2`**, max **3**), **no** cross-service scan fleet, **no** supervisor, **sequential** answer resolver, CSV ingest scan often at **`WORKER_POOL_SIZE=1`**.

## 1.1 Architecture (today)

```text
[Operators] → [Single Railway service]
                ├── Express + dashboard
                ├── Optional: 2–3× runLiveSubmit (queueWorker embedded)
                ├── Zoho: 1 browser / 1 lock per process
                └── Batch prep (manual / npm start / ingest):
                      scan (often 1 worker) → segregate → resolve (serial) → READY_FOR_REVIEW
```

| Component | Current behavior |
|-----------|------------------|
| Scan | `PlaywrightScanner` / `storageCsvIngestion` — often **1** scanner worker on Railway |
| Resolve | `AnswerResolver.resolveAllApplications` — **nested sequential loops**; profile/resume/QA **re-fetched per job** |
| Submit | `SubmissionQueueDaemon` — max **3** workers per process |
| Multi-service dequeue | Supported by **DB**, not required for ops |

## 1.2 Prep time **now**

| Phase | Driver | Typical | Range |
|-------|--------|---------|-------|
| Ingest + segregate | CSV size, DB | **~15–25 min** | 10–30 min |
| Scan (new URLs only, **1** scanner worker) | ~200 URLs | **~45–90 min** | 35 min–2 h |
| Scan (if **3** workers, manual `runScan --workers=3`) | ~200 URLs | **~25–45 min** | 20–60 min |
| Answer resolve (**serial**, warm Supabase) | 3,000 apps | **~4–8 h** | 2.5–12 h |
| Operator approve (60 parallel) | 3,000 enqueues | **~40–75 min** | 35–100 min |

**Prep total (wall clock, same day — sequential prep then approve):**

| Ops habit | Total prep |
|-----------|------------|
| Default Railway ingest (**1** scan worker) + serial resolve | **~6–10 h** |
| Manual **3** scan workers + serial resolve | **~5–8 h** |
| Best realistic **without code changes** (3 scan workers, warm bank, fast skim) | **~5–7 h** |

Prep is dominated by **answer resolution (~4–8 h)**, then **scan**, then **~1 h** human approve.

## 1.3 Application time **now**

| Workers | Zoho pipelines | Effective jobs/h (100% OTP) | **3,000** applications |
|--------:|----------------:|----------------------------:|-------------------------:|
| **2** (default embed) | 1 | **~35–45** | **~67–85 h** (~2.8–3.5 d) |
| **3** (max per process) | 1 | **~50–55** | **~55–60 h** (~2.3–2.5 d) |

**Application total to plan on today:** **~55–60 h** with **3** workers and **one** Zoho session (OTP queueing inside the process).

## 1.4 End-to-end **now**

| Metric | Value |
|--------|--------|
| Prep (typical) | **~6–9 h** |
| Application | **~55–60 h** |
| **CSV → last `APPLIED`/`FAILED`** | **~2.5–3.5 calendar days** (continuous workers) |

## 1.5 Baseline bottlenecks

1. **Serial resolver** — 3,000 × repeated DB/resume/LLM work.  
2. **Single-process Zoho lock** — 3 submit workers share **one** OTP reader.  
3. **Low scanner parallelism** on default ingest (**1** worker).  
4. **No** idle scan→submit handoff on a hybrid service (manual mode switches).

---

# Section 2 — Most optimized **low / $0 marginal** path (multiple services + supervisor)

**Goal:** Minimize **extra Railway spend** (reuse **Hobby $5** credit, **1 GB** services, stop workers when idle) while approaching best **prep ~1.5–2 h** and **application ~13–17 h** through **architecture + targeted code**, not bigger machines.

## 2.1 Target architecture

```text
S1  [API + 1 submit worker]     ──always enqueue + drain (1 slot)
S2  [supervisor 2 slots]        ── scan queue OR submit queue
S3  [supervisor 2 slots]        ── scan queue OR submit queue
S4  [supervisor 2 slots]        ── scan queue OR submit queue
S5  [supervisor 2 slots]        ── scan queue OR submit queue

         ┌─────────────────────────────────────┐
         │ Supabase                             │
         │  • scan_tasks (url, SKIP LOCKED)     │  ← NEW (supervisor prep)
         │  • candidate_applications (QUEUED…)   │  ← existing submit
         └─────────────────────────────────────┘
```

| Service | RAM (free tier) | Submit slots | Scan slots | Zoho |
|--------:|----------------:|-------------:|-----------:|-----:|
| **S1** | 1 GB | **1** | **0** | 1 session |
| **S2–S5** | 1 GB each | **0–2** (supervisor) | **0–2** (supervisor) | 1 session **each** |

**Effective peaks (1 GB — use `--workers=2` per service, not 3):**

- **During heavy scan:** up to **8** scan browsers (S2–S5 × 2); **S1** may still submit (**1** worker).  
- **After prep / idle supervisor:** **1 + 4×2 = 9** submit workers max — matches “~9 workers” **only if** RAM allows **2** per service stable.  
- **Conservative on 1 GB:** **1 + 4×1 = 5** submit workers if you must run **1** slot per service to avoid OOM.

**Supervisor rule (per slot):**

```text
if scan_task available (SKIP LOCKED):  run scanSingleUrl → upsert template
else if application QUEUED:             runLiveSubmit
else:                                   sleep(pollInterval)
```

**Resolve:** Run as a **batch step** after scan (or stream per template); requires **parallel per-candidate resolve** (code) — not part of per-slot supervisor unless you add `resolve_tasks` queue.

## 2.2 Required engineering (beyond config)

| Item | Purpose | Prep impact | Apply impact |
|------|---------|-------------|--------------|
| `scan_tasks` + claim RPC (`SKIP LOCKED`) | Shard scan across S2–S5 | **Large** | — |
| Supervisor process (`elasticWorker` or extend `queueWorker`) | Scan else submit | Medium | Medium |
| Parallel resolve + per-candidate context cache | Cut resolve wall time | **Large** | — |
| Incremental skip `(applywizz_id, job_url)` | Repeat questions/URLs | **Large** on wave 2+ | — |
| Zoho `init()` on daemon boot | Shave first-job OTP delay | Small | Small |
| OTP **3 min** → `FAILED` | Free stuck slots | — | Medium |
| `queueWorker --interval=1000` | Slightly higher dequeue rate | — | Small |

## 2.3 Prep time — optimized free / multi-service

| Phase | Workers | Typical | Range |
|-------|--------:|---------|-------|
| Ingest + segregate | — | **~15–25 min** | 10–30 min |
| Scan | **8** (S2–S5 × 2), ~200 new URLs | **~12–22 min** | 8–35 min |
| Resolve (parallel **15** candidates, warm bank) | 1 process¹ | **~1–2 h** | 45 min–2.5 h |
| Operator approve | 60 parallel | **~40–50 min** | 35–75 min |

¹ Resolve can run on **S1** during scan (CPU only) or a one-shot job before supervisors flip fully to submit — no extra service cost if scripted.

**Prep total (optimized free path):**

| | Time |
|---|------|
| **Planning number** | **~1.5–2 h** |
| **Bracket** | **~1.25–2.5 h** |

**vs Section 1:** save **~4–7 h** on prep (mainly resolve + scan parallelism).

## 2.4 Application time — optimized free / multi-service

| Config | Parallel submit | Zoho sessions | **3,000** apps @ 100% OTP |
|--------|----------------:|--------------:|----------------------------:|
| **Aggressive 1 GB** (2+2+2+2+1) | **9** | **5** | **~11–15 h** |
| **Realistic 1 GB** (1+1+1+1+1) | **5** | **5** | **~18–24 h** |
| **Mid (mixed)** | **7** | **5** | **~13–18 h** |

**Planning number (realistic with mostly 2 slots on S2–S5 after tuning):** **~13–17 h**  
**Bracket:** **~11–24 h** depending on OOM throttling and OTP speed.

## 2.5 Railway cost (marginal)

| Pattern | Cost behavior |
|---------|----------------|
| **Hobby $5/mo** | **$5** subscription includes **$5** usage credit; metered RAM/CPU per second while services **run** |
| **5 services × 1 GB** always on | Often **exceeds** $5 credit if 24/7 — **stop S2–S5** when queue empty |
| **Wave ops** | Run **S1** always; spin **S2–S5** for **~15–20 h** per wave → fits frugal use of credit |
| **No per-worker or browser-minute fee** | Only container RAM/CPU |

**Free-style ops playbook:** S1 24/7; S2–S5 deploy for prep + drain; scale to **0** after backlog clear.

## 2.6 End-to-end — Section 2

| Metric | Typical | Range |
|--------|---------|-------|
| Prep | **~1.5–2 h** | 1.25–2.5 h |
| Application | **~13–17 h** | 11–24 h |
| **CSV → done** | **~15–19 h** | 13–26 h |

---

# Section 3 — **Paid Railway: one service** sized for **~9 submit workers**

**Goal:** One Railway **service** (API + queue + Zoho) with enough **RAM/vCPU** to run **9** concurrent `runLiveSubmit` browsers reliably. Prep still uses the same optimizations as §2 (incremental scan, parallel resolve); scan can run as a **batch window** on the same box before/during the wave (supervisor optional).

> **Repo limit today:** `SubmissionQueueDaemon` clamps **`WORKER_CONCURRENCY` to max 3** per Node process (`queueWorker.ts`). To run **9** workers on **one** service you must either **raise that cap** and set `WORKER_CONCURRENCY=9`, or run **3** daemon processes × `--workers=3` in one container (recommended for **3 Zoho OTP pipelines**).

---

## 3.1 Railway subscription & list prices (2026)

Source: [railway.com/pricing](https://railway.com/pricing) — billed **per second** while the service is running; **stopped** services do not accrue compute.

### Plan fees (workspace)

| Plan | Monthly subscription | Included usage credit | Max per **single** service |
|------|---------------------:|----------------------:|----------------------------|
| **Free** | $0 | $1/mo | 1 vCPU / **0.5 GB** — not viable for 9 workers |
| **Hobby** | **$5/mo** | **$5/mo** toward usage | up to **48 vCPU / 48 GB** |
| **Pro** | **$20/mo** | **$20/mo** toward usage | up to **1,000 vCPU / 1 TB** |

Credits **do not roll over**. You pay the subscription each month; if **metered usage** exceeds the credit, you pay the **overage** (usage is not “free” beyond the credit).

### Metered resource rates (usage)

| Resource | ≈ Monthly rate (if run 24/7 at constant size) |
|----------|---------------------------------------------|
| **Memory** | **$10 / GB / month** |
| **CPU** | **$20 / vCPU / month** |
| **Volume storage** | $0.15 / GB / month |
| **Egress** | $0.05 / GB |

There is **no** separate charge for “workers” or “browser minutes” — only **RAM + vCPU + disk + egress** for the one service.

### Example monthly compute (service running 24/7)

| Config (vCPU + RAM) | Usage / month (compute only) | Bill sketch (Hobby **$5** credit) | Bill sketch (Pro **$20** credit) |
|---------------------|-----------------------------:|----------------------------------:|----------------------------------:|
| 4 vCPU + **6 GB** | 80 + 60 = **$140** | **~$140** total¹ | **~$140** total¹ |
| 4 vCPU + **8 GB** | 80 + 80 = **$160** | **~$160** | **~$160** |
| **8 vCPU** + **8 GB** | 160 + 80 = **$240** | **~$240** | **~$240** |

¹ Typical pattern: **$subscription + max(0, usage − credit)** → for $140 usage, Hobby ≈ **$5 + ($140−$5) = $140**; Pro ≈ **$20 + ($140−$20) = $140** when usage dominates. The **plan fee buys headroom and limits**, not “free RAM.”

### Example **per wave** (one service, **~22 h** on for prep + application)

Assume **8 GB RAM + 4 vCPU** for the wave:

```text
RAM cost  ≈ 8 GB × ($10/730 h) × 22 h ≈ $2.40
CPU cost  ≈ 4 vCPU × ($20/730 h) × 22 h ≈ $2.40
Compute   ≈ $4.80 per wave (+ egress pennies–dollars)
```

Four waves/month ≈ **~$19** compute + **$5 or $20** subscription → budget **~$25–40/mo** if you **stop** the service between waves. **24/7** same size ≈ **~$160/mo** compute alone.

---

## 3.2 Sizing **one** service for 9 workers

| Component | RAM (planning) |
|-----------|----------------|
| 9 × Chromium (submit) | **~3.2–4.5 GB** (350–500 MB each under load) |
| 1 × Zoho Playwright | **~0.3–0.5 GB** |
| Express + Node | **~0.2–0.4 GB** |
| Headroom (spikes, screenshots) | **~1–2 GB** |
| **Recommended provision** | **8 GB RAM** + **4–6 vCPU** |
| **Minimum (tight)** | **6 GB RAM** + **4 vCPU** |

| vCPU | Why |
|-----:|-----|
| **4** | Usable for 9 headless browsers |
| **6–8** | Less CPU thrash when 9 fills + OTP + dashboard |

In Railway: set **service limits** (Settings → Resources) to these values on **Hobby** or **Pro** — no special “worker tier”; you scale **one** service’s RAM/vCPU.

---

## 3.3 How to run 9 workers on **one** service

### Option A — Three daemons (recommended for 100% OTP)

One container start script:

```bash
node dist/server/index.js &                    # API; ENABLE_QUEUE_WORKER=false
node dist/submitter/queueWorker.js --workers=3 --interval=1000 &
node dist/submitter/queueWorker.js --workers=3 --interval=1000 &
node dist/submitter/queueWorker.js --workers=3 --interval=1000 &
wait
```

- **9** submit loops, **3** Node processes → **3** Zoho locks (OTP parallelized better than 1 process).
- API stays responsive if `ENABLE_QUEUE_WORKER=false` on Express.

### Option B — Single daemon (requires code change)

- Raise max in `queueWorker.ts` (today **hard cap 3**).
- `ENABLE_QUEUE_WORKER=true`, `WORKER_CONCURRENCY=9` on `server/index.js`.
- **1** Zoho lock → **9** workers often **queue on OTP**; expect **slower** than Option A at 100% OTP.

### Prep on the same service

| Approach | Prep time (same as §2) |
|----------|-------------------------|
| **Batch** before drain: `runScan --workers=5` then `runResolver` (no submit workers running) | **~1.25–2 h** |
| **Supervisor** sharing slots (future code) | **~1.25–1.75 h** with overlap |

During **batch prep**, keep submit daemons **off**; start triple-daemon after `READY_FOR_REVIEW`.

---

## 3.4 Prep time — paid single service

Same targets as §2 (parallel resolve + incremental scan); large RAM does not speed resolve much.

| | Typical | Range |
|---|--------:|------:|
| **Prep total** | **~1.25–1.75 h** | 1–2.25 h |

---

## 3.5 Application time — paid single service, 9 workers

| Setup | OTP pipelines | **3,000** apps @ 100% OTP |
|-------|-------------:|----------------------------:|
| **Option A** (3× daemon × 3 workers) | **3** | **~12–15 h** typical |
| **Option B** (1× daemon × 9 workers) | **1** | **~16–22 h** (OTP serializes) |

| Scenario (Option A) | Hours |
|---------------------|------:|
| Optimistic (~2.2 min/job) | **~11–13 h** |
| **Planning** (~2.4 min/job) | **~12–15 h** |
| Conservative (~2.8 min/job) | **~15–18 h** |

**Application total to plan:** **~12–15 h** with **3** Zoho processes; **~16–22 h** with **1** Zoho.

---

## 3.6 End-to-end — Section 3 (single paid service)

| Metric | Typical (Option A) | Range |
|--------|-------------------|-------|
| Prep | **~1.25–1.75 h** | 1–2.25 h |
| Application | **~12–15 h** | 11–22 h |
| **CSV → done** | **~13.5–17 h** | 12–24 h |

---

## 3.7 What to buy (practical recommendation)

| Item | Recommendation |
|------|----------------|
| **Plan** | **Hobby ($5/mo)** if one project and you stop service between waves; **Pro ($20/mo)** if team + 30-day logs + higher limits |
| **Service size (wave)** | **8 GB RAM**, **4 vCPU** (bump to **6 vCPU** if CPU pegged) |
| **Always-on API only** | Separate **small** service (0.5–1 GB) for dashboard + **large** worker service for waves — *two* services; this section is **one fat service** for simplicity |
| **Budget** | **~$5–20/mo** subscription + **~$5–25/mo** usage if **event-driven**; **~$140–160/mo** if **8 GB / 4 vCPU 24/7** |

---

# Summary comparison table

| | **§1 Now** | **§2 Optimized free** (multi + supervisor) | **§3 Paid — 1 service, 9 workers** |
|---|------------|---------------------------------------------|----------------------------------|
| **Services** | 1 (+ manual batch) | 5 (S1 + supervised S2–S5) | **1** (8 GB / 4 vCPU typ.) |
| **Submit workers (peak)** | 2–3 | 5–9 (RAM-limited) | **9** (3× daemon × 3) |
| **Zoho pipelines** | 1 | up to 5 | **3** (recommended) |
| **Prep time** | **~6–9 h** | **~1.5–2 h** | **~1.25–1.75 h** |
| **Application time** | **~55–60 h** | **~13–17 h** | **~12–15 h** |
| **CSV → done** | **~2.5–3.5 d** | **~15–19 h** | **~13.5–17 h** |
| **Railway cost** | Lowest | **Hobby $5** + wave uptime | **Hobby/Pro + ~$5/wave** or **~$140–160/mo** 24/7 |
| **Code required** | — | Scan queue, supervisor, parallel resolve | **Raise worker cap** or **3 daemons**; same prep as §2 |

---

# Implementation priority (all optimized paths)

1. **Migration 005** + enqueue-only API on S1 (`ENABLE_QUEUE_WORKER` only where intended).  
2. **`scan_tasks` + SKIP LOCKED** — unlock multi-service scan.  
3. **Supervisor** on S2–S5 (prep else submit).  
4. **Parallel resolve + per-candidate cache + incremental skip**.  
5. **Zoho init on worker boot**; OTP timeout policy (**3 min** → `FAILED`).  
6. **Pilot wave** on Railway usage graph → tune `--workers` vs RAM.

---

# Document history

| Date | Change |
|------|--------|
| 2026-09-10 | Initial report: §1 baseline, §2 free multi-service + supervisor, §3 paid single-service 9 workers + Railway prices |
