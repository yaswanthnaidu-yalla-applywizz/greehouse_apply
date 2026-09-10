# Capacity & Timing Math — Greenhouse Apply Pipeline

Reference document for operator scale, queue workers, and CSV link reuse.  
**Last updated:** 2026-09-10 (conversation synthesis).

---

## 1. CSV reference (`greenhouse_only_applywizz_prod(in).csv`)

| Metric | Count | Notes |
|--------|------:|-------|
| Total CSV rows | 1,048,575 | Most rows have no `url` |
| Rows with non-empty `url` | **5,437** | Job **assignments** (candidate + job) |
| Unique exact URL strings | **420** | Raw cell text |
| Unique **normalized** URLs | **419** | After stripping tracking params (see §2) |
| `grnh.se` shortlinks (unique) | 276 | Distinct short codes |
| Unique **canonical** URLs (after shortlink resolve) | **401** | What Playwright scan should open |

**Reuse factors (prod CSV):**

- Assignments per distinct URL string: `5,437 ÷ 420 ≈ 13.0`
- Assignments per canonical job: `5,437 ÷ 401 ≈ 13.6`

---

## 2. URL normalization & shortlink resolving

### Normalization (`normalizeGreenhouseUrl`)

Cleans URLs before deduplication so the same job is not scanned twice:

1. Trim; require `http(s)`.
2. Force `https`, lowercase hostname.
3. Remove tracking query params (`gh_src`, `utm_*`, `gclid`, etc.).
4. Keep job-identifying params (e.g. embed `token=...`).

**Effect:** Two URLs that differ only by `gh_src` → **one** normalized URL.  
**Example:** 420 exact strings → **419** normalized (one pair collapsed).

### Shortlink resolving (`grnh.se`)

HTTP follow of `https://grnh.se/...` to the final Greenhouse `job-boards.greenhouse.io/...` URL, then normalize.

**Effect:** Different shortlinks pointing at the same posting → **one** canonical URL.  
**Example:** 419 normalized (incl. shortlinks) → **401** canonical jobs (**18** shortlinks duplicate an existing full URL).

---

## 3. Planning scenario (default)

| Parameter | Value |
|-----------|--------|
| Operators (CAs) | 60 |
| Candidates | 300 (~5 per operator if even) |
| Jobs per candidate (max) | 10 |
| Max assignments | **300 × 10 = 3,000** |
| Submit workers | **3** (`WORKER_CONCURRENCY`, max 3 in `queueWorker.ts`) |
| OTP | **Every application** (Zoho auto-read; **global serial lock** on one browser) |
| Eligible forms | Field count **< 23** (`MAX_JOB_QUESTIONS`) |
| “60 applying at once” | Parallel enqueue; **does not** add browsers |

### Expected unique jobs for 3,000 assignments (same reuse as prod CSV)

| Estimate | Formula | Result |
|----------|---------|--------|
| Proportional canonical | `3,000 ÷ 13.6` | **~220** |
| Ceiling (same pool as CSV) | `min(3,000, 401)` | **≤ 401** |

**Scan planning:** use **~250** typical, **401** worst case.

---

## 4. Phase definitions

| Bucket | Includes |
|--------|----------|
| **Prep work** | Scan templates → segregation/profiles → answer resolve → operator review & **Approve & Submit** (HTTP queue only) |
| **Application time** | `QUEUED` → `runLiveSubmit` → OTP → proof → `APPLIED` / `FAILED` until backlog empty |

---

## 5. Time math by phase

### 5.1 Scanning

```
scan_hours ≈ (unique_urls × seconds_per_url) / (3600 × scanner_workers)
```

| `seconds_per_url` | 1 worker | 3 workers |
|-------------------|----------|-----------|
| ~25 s | ~1.7 h @ 250 URLs | ~35 min |
| ~35 s (typical) | ~2.4 h @ 250 | **~49 min** |
| ~45 s | ~3.1 h @ 250 | ~1.0 h |

At **401** unique, multiply durations by `401/250` (~1.6×).  
**Note:** Railway CSV ingest often uses **1** scanner worker; batch jobs can use `WORKER_POOL_SIZE=3+`.

### 5.2 Segregation

~**10–20 min** for 300 candidates (Supabase/cache profiles).

### 5.3 Answer resolution (single-threaded)

```
resolve_hours ≈ (applications × avg_seconds_per_app) / 3600
```

| Avg per app | 3,000 apps |
|-------------|------------|
| ~3 s (warm QA bank) | ~2.5 h |
| ~6 s (typical) | **~5 h** |
| ~10 s (heavy LLM) | ~8.3 h |

### 5.4 Operator approval (60 parallel)

Apps per operator: `3,000 ÷ 60 = 50`.

```
queue_wall_clock ≈ apps_per_operator × review_seconds
```

| Review / app | Wall clock |
|--------------|------------|
| 45 s | ~38 min |
| 90 s | **~75 min** |
| 2 min | ~100 min |

Enqueue: **< 100 ms** per click (not Playwright-bound).

### 5.5 Application / submit (bottleneck)

**Per job (one worker occupied, OTP every time):**

| Segment | Typical |
|---------|---------|
| Open → fill → submit → OTP detected | ~75–120 s |
| Zoho OTP fetch (serialized globally) | ~20–60 s (up to 90 s) |
| OTP fill + verify (≤30 s) | ~15–35 s |
| Proof + 2 s worker poll | ~10–20 s |
| **Total per job** | **~2.5–4.0 min** |

**Throughput (3 workers + serial Zoho — effective, not 3× naive):**

```
submit_hours ≈ applications / jobs_per_hour
```

| `jobs_per_hour` | 3,000 apps |
|-----------------|------------|
| 60 | 50 h |
| 55 (realistic) | **~55 h** |
| 50 | 60 h |

**Application total:** **~50–60 h** (~**2.1–2.5 calendar days**) continuous worker runtime.

---

## 6. Prep vs application totals

| | Typical | Range |
|---|--------:|------:|
| **Prep work** | **~7 h** | ~5–11 h |
| **Application time** | **~55 h** | ~50–60 h |
| **Combined (back-to-back)** | **~62 h** | ~55–71 h (~2.3–3 days) |

**Prep breakdown (typical ~7 h):**

| Step | ~Time |
|------|------:|
| Scan (~250 unique, 3 workers) | ~1 h |
| Segregation | ~15 min |
| Resolve | ~5 h |
| Operator approval | ~1 h |

**If templates already scanned:** omit ~1 h scan → prep **~6 h** typical.

---

## 7. Queue & infrastructure notes

- Operators: instant `QUEUED` via `enqueueApplication`; FIFO `submission_order`.
- Workers: `SubmissionQueueDaemon`, max **3** concurrent `runLiveSubmit` per process.
- Zoho: `zohoReader.ts` **single lock** — concurrent workers queue on OTP.
- RAM rule of thumb: ~**350 MB** per Chromium; 3 workers + API + Zoho → prefer **≥4 GB** container.
- Horizontal scale: multiple daemons + `get_next_queued_application` / `SKIP LOCKED` (see `round_robin_queue_scheduler.md`).

---

## 8. Levers to reduce time (summary)

| Lever | Prep | Application | Effort |
|-------|------|-------------|--------|
| Incremental scan / template cache | ~1 h | — | Low |
| Parallel answer resolver + warm QA bank | ~2–4 h | — | Medium |
| 2nd Railway daemon (+3 workers) | — | ~÷2 | Low–medium |
| Multiple Zoho readers or Mail API/IMAP for OTP | — | ~30–50% with more workers | Medium–high |
| Lower worker poll interval when backlog deep | — | Small | Low |

**Order of impact:** unblock OTP parallelism → add worker services → prep caching/parallel resolve.

---

## 9. One-line formulas

```
assignments      = candidates × max_jobs_per_candidate     → 300 × 10 = 3,000
unique_jobs      ≈ assignments / 13.6                     → ~220–401 (scan)
scan_time        ≈ unique × 35s / (3600 × scan_workers)
resolve_time     ≈ 3,000 × 6s / 3600                      → ~5 h (mid)
approve_time     ≈ (3,000/60) × review_seconds            → parallel wall clock
submit_time      ≈ 3,000 / 55                             → ~55 h (OTP always, 3 workers)
```

---

## 10. Open inputs (fill from stakeholder interview)

- [ ] Railway plan / RAM per service
- [ ] `WORKER_CONCURRENCY` and number of daemon replicas
- [ ] Zoho: single tenant vs sharded inboxes; API vs Playwright reader
- [ ] OTP rate assumption (100% vs measured %)
- [ ] Scanner workers for batch vs always-on API
- [ ] Target SLA (e.g. “all 3,000 in 24 h”)
- [ ] Acceptable monthly infra cost for extra workers
