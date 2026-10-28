# WAR REPORT: Dashboard Performance, Architecture & Scalability Blueprint (`war.md`)

**Date:** 2026-10-28  
**System:** ApplyWizz Greenhouse Automation Platform — Operational Dashboards (Operator, Manager, Admin, Dev)  
**Authors & Methodologies:** Candidate 1 (Claude Sonnet 4.6 Base) + Candidate 2 (Gemini 3.8 Flash High Grafts) via `/pstack:arena`, `/agent-skills:performance-optimization`, `/pstack:architect`, `/pstack:blast-radius`, `/ponytail`  
**Grounding Documents:** Synthesis, critical reconciliation, and source verification of `docs/dashboard-performance-audit.md` (Ground Truth Audit) and `docs/perf.md` (Legacy Proposal).  
**Ironclad Governance:** Strictly adheres to **Rule 12 of `AGENTS.md`** (never trade success rate for failure reduction; preserve 5-tier resolver and Playwright submission engines 100% intact).  
**Execution Mandate:** **Phase 1: Access Control & Data Integrity** MUST gate all work before proceeding to **Phase 2: Performance, Scalability & Debloat**.

---

## 1. Executive Summary & Critical Reconciliation

The dashboard ecosystem provides operational oversight, queue orchestration, and manual verification for high-volume job applications across four distinct personas:
1. **Operators (Career Associates):** Review candidate answers, verify resolved fields, execute dry-runs, edit form dropdowns, and approve submissions.
2. **Managers:** Supervise team-wide candidate queues, operator allocations, and submission throughput.
3. **Admins:** Ingest candidate CSVs, oversee org-wide metrics, trigger synchronizations, and audit operational runs.
4. **Devs:** Technical diagnostics, worker lane monitoring, and direct DB/storage health inspection.

### Critical Reconciliation: `docs/dashboard-performance-audit.md` vs. `docs/perf.md`

| Dimension | `docs/perf.md` (Legacy Proposal) | `docs/dashboard-performance-audit.md` (Current Ground Truth) | `war.md` Authoritative Resolution |
|---|---|---|---|
| **Access Control & Security** | Ignored; focused purely on speed and latency. | Discovered critical leak: `allowedCandidateIds: []` exposes org-wide data; WS is unauthenticated. | **Mandatory Phase 1 Prerequisite:** Secure WebSocket with JWT authentication + role scoping, and enforce strict empty-set scoping before touching performance. |
| **Data Integrity (`profiles`)** | Identified destructive upsert bug in `upsertProfile`. | Confirmed destructive upsert in `upsertProfile` and destructive hydration loop in Admin routes. | **Immediate P0 Fix:** Merge-safe profile upsert (strip `null`/`undefined` updates); purge all runtime hydration loops (`POST /api/auth/hydrate-admin` and `ensureAdminHydrated`). |
| **Application Column Slimming** | Proposed replacing `select('*')` with 16 scalar columns everywhere in `applications.ts`. | Caught critical flaw: Operator form renderer (`dashboard/FormRenderer.tsx:124`) **strictly requires** `resolved_fields` and edit flags. | **Partitioned DTOs:** Lightweight 16-scalar columns for summary queues and manager views; full `resolved_fields` and template dropdown options preserved for single-app reviews. |
| **Work History API Scoping** | Recommended complete immediate deletion based on static snapshot (1,313/1,313 rows). | Cautioned that production assignment coverage must be verified live before removing fallbacks. | **Database-Driven Scoping:** Verified live DB2 assignment coverage; use `assigned_ca_email` in `gh_candidate_applications` and `ca_email` in `profiles` for 100% of dashboard reads. Decouple Work History from all dashboard routes. |
| **Notification Dismissals** | Not analyzed. | Found shared JSON file and in-memory set causing cross-user hiding and Railway multi-instance desyncs. | **Browser `localStorage`:** Move dismissal state to browser storage (`applywizz_dismissed_notifications`). Delete server file and in-memory set entirely. |
| **Admin Date Controls** | Assumed functional. | Revealed that Admin Manager/Operator endpoints return lifetime stats; date picker triggers no-op network calls. | **Unified Date Contract:** Implement `[ Today \| Lifetime \| Custom Date ]` backed by indexed `gh_application_stats_daily` rollups. |
| **Polling & Realtime** | Proposed increasing fallback poll from 3s to 15s. | Found 4 overlapping refresh loops (WS + Realtime + 2s badge poll + 3s proof poll) firing ~50 req/min per tab. | **Consolidated Realtime:** Authenticated WS push as primary; eliminate 2s/3s polls; paced 15s disconnected / 45s connected fallback poll gated on visibility. |
| **External Fonts** | Not analyzed. | Google Fonts (Inter) requested in emitted HTML is blocked by dashboard CSP, triggering browser errors. | **Remove Font Requests:** Drop Google Fonts preconnect/links in `vite.config.ts`; rely on clean system font stack. |

---

### Measured Baselines vs. Target SLAs

| Performance Dimension | Baseline Before Fix | Target SLA After Fix | Expected Gain |
|---|---|---|---|
| **Admin Dashboard Initial TTFB** | 1,800ms – 4,500ms | **≤ 150ms** | **~94% faster** (Eliminate Work History & hydration) |
| **Operator Dashboard Initial TTFB**| 900ms – 2,500ms | **≤ 100ms** | **~92% faster** (Direct PostgreSQL index seek) |
| **Applications Queue Payload** | ~450 KB (for 50 apps) | **≤ 35 KB** | **~92% reduction** (Drop unneeded `resolved_fields`) |
| **Poller Traffic (Offline WS)** | ~60 req/min per tab | **≤ 4 req/min per tab** | **~93% reduction** (15s paced fallback poll) |
| **Poller Traffic (Active Review)** | ~50 req/min per app | **0 req/min** | **100% eliminated** (Kill 2s/3s badge & proof polling) |
| **Admin Ingest Poller (Idle)** | 20 req/min forever | **0 req/min** | **100% eliminated** (Adaptive poll on running only) |
| **Emitted Dashboard HTML Size** | Blocked font links | **Clean CSP zero-error** | **0 blocked network requests** |

---

### Rule 12 Failure Classification Matrix

Per Rule 12 of `AGENTS.md`, before proposing any change to the resolver, form filler, scanner, or submission engine, failures must be explicitly classified:

| Failure Target | Classification | Justification & Architectural Decision |
|---|---|---|
| Profile demographic wipe on Admin visit | **Code Bug** | `upsertProfile` explicitly coerces missing fields to `null`, and `adminProfileHydrate.ts` passes 4 fields. Justifies surgical code fix to `upsertProfile` and deleting the hydration loop. |
| Organization-wide notification & stats leak | **Code Bug** | Query builders treat empty array `[]` as non-existent filter rather than empty set. Justifies surgical guard: `allowedCandidateIds.length === 0` must return 0 rows. |
| Unauthenticated WebSocket failure broadcast | **Code Bug** | `/ws` lacks upgrade authentication and broadcasts private candidate data to all sockets. Justifies upgrade JWT verification and candidate scoping. |
| High latency on `/api/candidates` and `/api/applications` | **Code Bug / Architecture Debt** | Synchronously calling external Work History API when 100% of data is already in PostgreSQL. Justifies cutover to database-driven scoping. |
| Application badge & submission controls poll spam (50 req/min) | **Code Bug / Redundancy** | Polling every 2s/3s for data already pushed over WebSocket upon worker completion. Justifies eliminating local intervals. |
| Unassigned operator seeing 0 candidates | **Data Fault / Normal State** | Legitimate state when a newly onboarded CA has no candidates assigned. Must safely return empty list without crashing or leaking other operators' data. |
| Network timeout during worker Playwright submission | **Retryable** | External network/Greenhouse ATS latency. Handled by existing retry queue and worker backoff; dashboard must remain observer only. |

---

## 2. Comprehensive Inventory: Polling, API Calls & DB Queries

### A. Frontend Polling Loops Audit (All 9 `setInterval` Instances)

| # | File & Line | Trigger / Condition | Current Rate | Verdict | Proposed Replacement & Action |
|---|---|---|---|---|---|
| **1** | `dashboard/App.tsx:337` | Disconnected WS fallback poller (`fetchInitialData`, `fetchNotifications`) | 3s (if WS down) / 30s (if WS up) | **Unoptimized** | **Paced Adaptive Poller:** Change disconnected interval from 3s to **15s**; connected interval from 30s to **45s**. Gate execution on `document.visibilityState === 'visible'`. |
| **2** | `dashboard/components/ApplicationStatusBadge.tsx:67` | Status is `APPLYING`, `QUEUED`, `OTP_REQUIRED`, `EMAIL_PROOF_PENDING`, or `FAILED` | **Every 2s unconditionally** | **KILL (Redundant)** | **Eliminate Interval Entirely.** Status transitions and failure reasons are pushed via WebSocket (`APPLICATION_STATUS_CHANGED`). Polling every 2s floods Express with ~30 req/min per badge. |
| **3** | `dashboard/components/SubmissionControls.tsx:148` | Status is `APPLIED` / `EMAIL_PROOF_PENDING` and proof is `pending` | **Every 3s unconditionally** | **KILL (Redundant)** | **Eliminate Interval Entirely.** Duplicates badge polling. When worker captures email proof, it emits WebSocket event with `proof_email_url` / `proof_email_json`. UI consumes event directly. |
| **4** | `dashboard/components/AdminDashboard.tsx:528` | Admin dashboard auto-refresh (`refresh()`) | **Every 30s** | **Unoptimized** | **Visibility & Tab Gating:** Run refresh only if `document.visibilityState === 'visible'` and current tab is dynamic (`overview` or `activity`). Pause on static tabs (`system`, `guide`). |
| **5** | `dashboard/components/AdminDashboard.tsx:593` | CSV Ingest status poller (`/api/admin/ingest-status`) | **Every 3s unconditionally** | **Severe Waste** | **Adaptive Ingest Poller:** Poll at 3s **only** when `ingestRun?.running === true`. When idle or finished, stop polling completely. |
| **6** | `dashboard/components/ManagerDashboard.tsx:524` | Manager dashboard auto-refresh (`load()`, `loadOperators()`, `loadActivity()`) | **Every 30s** | **Unoptimized** | **Visibility Gating & Tab Pushdown:** Pause when tab is backgrounded. Only refresh the active sub-tab. |
| **7** | `dashboard/components/DevDashboard.tsx:260` | Dev dashboard auto-refresh (`refresh()`) | **Every 30s** | **Heavy Burden** | **Increase to 60s + Backend Cache:** Dev refresh fires 4 heavy endpoints. Increase to 60s, gate on visibility, and add 10s backend response coalescing for health probes. |
| **8** | `dashboard/hooks/useSession.ts:446` | Token refresh check (`needsRefresh()`) | Every 60s | **Keep** | **Necessary & Lightweight:** Minimal in-memory date comparison; only executes network fetch if token is nearing expiration. |
| **9** | `dashboard/components/AuthView.tsx:125` | OTP resend countdown timer | Every 1s (cooldown) | **Keep** | **Pure UI State:** Zero network calls; standard timer decrements seconds. |

---

### B. Dashboard API Endpoints Audit

| Endpoint | Method | Caller | Current Behavior & Defect | Remedy & Replacement |
|---|---|---|---|---|
| `/api/candidates` | `GET` | Operator, Admin | Calls external Work History API (800ms–2,500ms TTFB). In Admin, calls `hydrateAdminProfilesFromWorkHistory`, triggering destructive profile writes. | **100% DB Scoping:** Scope via `assigned_ca_email = userEmail` in `gh_candidate_applications` and `profiles.ca_email`. Delete hydration loop. Target TTFB: **< 100ms**. |
| `/api/applications` | `GET` | Operator | Calls Work History for allowed IDs, then does `select('*')` downloading massive `resolved_fields` for entire queue. | **Slim Queue Projection:** Filter directly on `assigned_ca_email = userEmail`. Return 16-scalar summary columns (`ApplicationSummaryDto`). Cuts payload from ~450 KB to **~35 KB**. |
| `/api/applications/:id` | `GET` | Operator (Detail / Form) | Fetches single application for review. | **Preserve Full Schema:** Select all columns including `resolved_fields`, `user_inputs`, and proof URLs (`ApplicationDetailDto`). Form editing and approval flows remain 100% intact. |
| `/api/candidates/:id/jobs` | `GET` | Operator (Candidate View) | Fetches jobs for active candidate and enriches `resolved_fields` with template dropdown options. | **Preserve Schema & Form:** Keep full `resolved_fields` and template dropdown options for `FormRenderer.tsx`. Manual verification & editing 100% preserved. |
| `/api/auth/hydrate-admin` | `POST` | Admin, Operator (`App.tsx`) | React `useEffect` fires on every date change. Calls Work History and runs `upsertProfile` defaulting missing fields to `null`. | **DELETE ENTIRELY:** Drop route and frontend hook. Candidates are already ingested via storage CSV ingestion. |
| `/api/manager/applications` | `GET` | Manager | Calls `listApplications()` (unbounded `select('*')` across whole table), filters in JavaScript memory. | **SQL Filtering & Pagination:** Push status and manager team scope directly into PostgreSQL `.in('assigned_ca_email', teamCas).range(offset, offset + limit - 1)`. |
| `/api/manager/queue` | `GET` | Manager | Runs 3 concurrent unbounded `listApplications()` calls (`QUEUED`, `APPLYING`, `OTP_REQUIRED`), filters in memory. | **Single Consolidated Query:** Run one SQL query: `.in('status', ['QUEUED', 'APPLYING', 'OTP_REQUIRED'])` with server-side CA filtering. |
| `/api/admin/applications` | `GET` | Admin | Fetches 50 rows via `.range()`, then filters by `search` in JavaScript memory! Matches on row 51+ are invisible! | **SQL Search Pushdown:** Apply search (`.or(...)` on candidate name, job title, company, operator) **before** `.range()` and `.count()`. |
| `/api/notifications` | `GET` | All | `allowedCandidateIds: []` is coerced to `null`, leaking all org notifications to unassigned operators. Local JSON dismissal desyncs. | **Strict Scope + Local Storage:** `[]` immediately returns `[]`. Dismissals handled on client via `localStorage`. Drop server JSON file. |
| `/api/admin/managers` & `/operators` | `GET` | Admin | Accepts `?date=...` but returns lifetime metrics; date picker causes no-op queries. | **Unified Date Toggle:** Support `[ Today \| Lifetime \| Custom Date ]` using `gh_application_stats_daily` rollups. |
| `/ws` | `WS` | All Dashboards | Unauthenticated connection; broadcasts private candidate failures to all connected sockets; reconnects on candidate selection. | **Authenticate & Scope WS:** Require JWT on upgrade. Track client CA/candidate scope. Broadcast events only to authorized sockets. Remove UI selection deps. |

---

### C. Database & Query Engine Optimization Audit

| Component / Function | File & Lines | Current Performance Flaw | Architectural Fix |
|---|---|---|---|
| `upsertProfile()` | `src/db/profiles.ts:255-271` | Explicitly defaults missing fields via `profile.field ?? null`. PostgREST wipes existing phone, country, location, and LinkedIn URLs. | **Merge-Safe Update:** Strip `null` and `undefined` properties from payload object before sending to Supabase PostgREST. |
| Missing Index on `profiles` | `src/db/migrations/` | PostgreSQL index audit shows no index on `profiles(ca_email)`. | **Migration 039:** Add `CREATE INDEX IF NOT EXISTS idx_profiles_ca_email ON profiles(ca_email);`. |
| `getApplicationStats()` | `src/db/applicationStats.ts:267-279` | Runs a `for (const metric of ...)` loop doing 4 sequential `await` queries against `gh_application_stats_daily`. | **Grouped Aggregation / Promise.all:** Consolidate into a single grouped query or execute all 4 count checks concurrently via `Promise.all()`. |
| `getSystemHealthSnapshot()` | `src/server/healthSnapshot.ts:81-185` | Awaits DB probe, Storage probe, Zoho ping, and ApplyWizz ping in a strict serial waterfall, followed by sequential row counts. | **Concurrent Probing:** Execute independent probes via `Promise.allSettled()`. Add 10-second memory cache for health snapshot. |
| `listApplications()` | `src/db/applications/crud.ts:861-915` | `select('*')` without `limit`, downloads megabytes of heavy JSON blobs for queue listings. | **Add Projection & Limit:** Introduce `listApplicationSummaries()` selecting scalar columns with mandatory limit. |
| Admin Manager Totals | `src/server/adminManagerStats.ts:109-115` | Issues an exact-count query per manager in a loop ($O(N)$ database round trips). | **Grouped SQL Query:** Group by `manager_email` in a single query against `gh_application_stats_daily`. |

---

## 3. Architecture Design & Type Sketches (`/pstack:architect`)

### Principle: Boundary Isolation & Separation of Concerns

Interactive dashboard callers must never interact with raw external integration concepts (such as `workHistoryUnreachable`), nor should dashboard reads ever trigger database mutations. Scoping must be unified behind a clean, role-aware abstraction.

```
┌────────────────────────────────────────────────────────┐
│               Caller: Express Route Handler            │
│       GET /api/candidates  |  GET /api/applications    │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│             resolveDashboardScope(req)                 │
│   Determines role, extracts userEmail, executes SQL    │
└───────────────────────────┬────────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
     [Admin / Dev]      [Manager]       [Operator]
     Unrestricted       Team CAs        Direct CA Match
     Scope: ALL         Scope: IN (CAs) Scope: = ca_email
```

### Type Contract & Module Boundary Sketch

```typescript
// src/server/types/scoping.ts

export type DashboardRole = 'admin' | 'dev' | 'manager' | 'operator';

export interface DashboardAccessScope {
  role: DashboardRole;
  userEmail: string;
  unrestricted: boolean;
  /**
   * Allowed candidate applywizz_ids for this viewer.
   * If null, caller has org-wide unrestricted access (Admin/Dev).
   * If empty Set (size === 0), caller is RESTRICTED and has ZERO access.
   */
  allowedCandidateIds: Set<string> | null;
  /**
   * For managers: list of team operator emails under supervision.
   */
  teamOperatorEmails?: string[];
}

/**
 * Lightweight DTO for Candidate Application Queue Lists (cuts payload by ~92%)
 * Used by: /api/applications, /api/manager/applications, /api/admin/applications
 */
export interface ApplicationSummaryDto {
  id: string;
  applywizz_id: string;
  candidate_name: string;
  job_url: string;
  company_name: string;
  job_title: string;
  status: ApplicationStatus;
  assigned_ca_email: string | null;
  has_manual_edits: boolean;
  reviewed_at: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
  error_message: string | null;
  proof_web_url: string | null;
  proof_email_url: string | null;
  proof_failed_url: string | null;
}

/**
 * Full DTO for Single Application Form Verification & Approval (Preserves full schema)
 * Used by: /api/applications/:id, /api/candidates/:id/jobs (active review item)
 */
export interface ApplicationDetailDto extends ApplicationSummaryDto {
  resolved_fields: Record<string, unknown>;
  user_inputs: Record<string, unknown>;
  proof_email_json: Record<string, unknown> | null;
  error_details: Record<string, unknown> | null;
}
```

---

## 4. Phase 1: Access Control & Data Integrity Blueprint (P0 Gate)

Phase 1 is the non-negotiable prerequisite gate. No performance tuning, query refactoring, or poller changes are permitted until these 4 security and data integrity vulnerabilities are resolved and verified with tests.

### 4.1 Merge-Safe `upsertProfile()` Implementation

**File:** `src/db/profiles.ts`  
**Problem:** Lines 264–271 explicitly default missing fields via `field ?? null`. PostgREST treats these explicit `null`s as intentional wipes, executing `ON CONFLICT (applywizz_id) DO UPDATE SET phone=NULL, country=NULL, location=NULL...`.  
**Surgical Fix:** Clean the payload object by deleting any property that is `undefined` or `null`, unless it is an explicit primary identity column (`applywizz_id`, `client_name`) or handled by a specific override.

```typescript
// src/db/profiles.ts

export async function upsertProfile(
  profile: Partial<ProfileRow> & { applywizz_id: string; client_name: string }
): Promise<ProfileRow> {
  const isYaswanth = (profile.applywizz_id || '').trim().toUpperCase() === 'AWL-YASWANTH';
  const isAkshitha = (profile.applywizz_id || '').trim().toUpperCase() === 'AWL-31428' || (profile.client_name || '').toLowerCase().includes('akshitha');
  const companyEmail =
    profile.company_email ||
    extractCompanyEmailFromPayload(profile.raw_api_payload, profile.email);
  const sandboxCaEmail = getSandboxCaEmail();

  // 1. Initialize base payload with mandatory identity and timestamps
  const payload: Record<string, unknown> = {
    applywizz_id: profile.applywizz_id.trim().toUpperCase(),
    client_name: profile.client_name.trim(),
    updated_at: new Date().toISOString(),
  };

  // 2. Merge-Safe copy: ONLY copy fields that are explicitly defined and non-null
  const mergeKeys: (keyof ProfileRow)[] = [
    'first_name',
    'last_name',
    'email',
    'company_email',
    'ca_email',
    'phone',
    'country',
    'country_code',
    'location',
    'linkedin_url',
    'website_url',
    'github_url',
    'work_authorization',
    'requires_sponsorship',
    'education',
    'work_experience',
    'resume_url',
    'resume_storage_path',
    'raw_api_payload',
  ];

  for (const key of mergeKeys) {
    const val = profile[key];
    if (val !== undefined && val !== null) {
      payload[key] = val;
    }
  }

  // 3. Apply business rules and overrides safely
  if (companyEmail && !payload.company_email) {
    payload.company_email = companyEmail;
  }
  if ((companyEmail || profile.email) && !payload.email) {
    payload.email = companyEmail || profile.email;
  }
  if (sandboxCaEmail) {
    payload.ca_email = sandboxCaEmail;
  } else if (profile.ca_email) {
    payload.ca_email = profile.ca_email.trim().toLowerCase();
  }

  // Hardcoded sandbox/demo location overrides
  if (isYaswanth && !payload.location) {
    payload.location = 'Hyderabad, Telangana, India';
  } else if (isAkshitha && !payload.location) {
    payload.location = 'Dallas, Texas, United States';
  }

  // Preserve scanner-managed flag when not explicitly provided
  if (profile.zoho_connected !== undefined) {
    payload.zoho_connected = profile.zoho_connected;
  }

  if (isSupabaseConfigured()) {
    try {
      const saved = await upsertProfileRowWithSchemaCacheFallback(
        profile.applywizz_id,
        payload
      );
      if (saved) return saved;
    } catch (err: any) {
      log.warn(`[Profiles] Supabase upsert error: ${err.message}. Falling back to memory.`);
    }
  }

  // In-memory fallback
  const existing = memoryProfiles.get(payload.applywizz_id as string) || ({} as ProfileRow);
  const updated = { ...existing, ...payload } as ProfileRow;
  memoryProfiles.set(payload.applywizz_id as string, updated);
  return updated;
}
```

---

### 4.2 Empty-Scope Leak Elimination

**Files:** `src/db/applications/notifications.ts:84-105`, `src/db/applications/statsQueries.ts:263, 351`  
**Problem:** When `filter.allowedCandidateIds` is `[]` (an operator with 0 assigned candidates), `filter.allowedCandidateIds.length > 0` evaluates to `false`, leaving `allowedSet` as `null`. The SQL query builder then skips the `.in('applywizz_id', ...)` clause, executing an unrestricted query across the entire organization!  
**Surgical Fix:** Model empty restricted scope as an immediate zero-row return.

```typescript
// In src/db/applications/notifications.ts: getRecentNotifications()
export async function getRecentNotifications(
  limit = 50,
  filter?: { date?: string; createdAtRange?: CreatedAtRangeFilter; allowedCandidateIds?: string[] }
): Promise<NotificationItem[]> {
  // CRITICAL SECURITY GUARD: Empty restricted scope must strictly return 0 rows
  if (filter?.allowedCandidateIds !== undefined && filter.allowedCandidateIds.length === 0) {
    return [];
  }
  // ... rest of logic
```

```typescript
// In src/db/applications/statsQueries.ts: getSubmissionOutcomeCounts()
export async function getSubmissionOutcomeCounts(options?: {
  date?: string;
  createdAtRange?: CreatedAtRangeFilter;
  allowedCandidateIds?: string[];
}): Promise<{ successfulApplications: number; failedApplications: number }> {
  // CRITICAL SECURITY GUARD: Empty restricted scope must return zero counts
  if (options?.allowedCandidateIds !== undefined && options.allowedCandidateIds.length === 0) {
    return { successfulApplications: 0, failedApplications: 0 };
  }
  // ... rest of logic
```

```typescript
// In src/db/applications/statsQueries.ts: getDashboardApplicationMetrics()
export async function getDashboardApplicationMetrics(options?: {
  createdAtRange?: CreatedAtRangeFilter;
  allowedCandidateIds?: string[];
}): Promise<{ ... }> {
  // CRITICAL SECURITY GUARD: Empty restricted scope must return zero metrics
  if (options?.allowedCandidateIds !== undefined && options.allowedCandidateIds.length === 0) {
    return {
      totalApplications: 0,
      totalCandidates: 0,
      uniqueScannedJobs: 0,
      totalFieldsPopulated: 0,
      supabaseTaggedCount: 0,
      aiTaggedCount: 0,
      resumeTaggedCount: 0,
    };
  }
  // ... rest of logic
```

---

### 4.3 Authenticated & Role-Scoped WebSocket (`/ws`)

**File:** `src/server/ws.ts`  
**Problem:** `WebSocketServer` attaches to `/ws` without verifying credentials. Anyone can connect and receive broadcasts of candidate failures, error messages, applicant IDs, and proof screenshots.  
**Surgical Fix:** 
1. Intercept HTTP `upgrade` request, extract JWT token from query string (`?token=...`) or `Authorization` header, and verify via Supabase Auth / Session Token.
2. Determine user role and resolve their allowed candidate set.
3. Attach authenticated identity to socket client.
4. Filter all `broadcast()` events: Admins/Devs receive all; Operators receive only events matching their assigned candidates.

```typescript
// src/server/ws.ts (Enhanced Architecture)

import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { getDbClient, isSupabaseConfigured } from '../db/client.js';
import { getRoleForEmail, isDevEmail } from '../auth/roles.js';

interface AuthenticatedClient {
  ws: WebSocket;
  email: string;
  role: 'admin' | 'dev' | 'manager' | 'operator';
  allowedCandidateIds: Set<string> | null; // null = unrestricted
}

class WebSocketManager {
  private wss: WebSocketServer | null = null;
  private clients: Set<AuthenticatedClient> = new Set();

  public init(server: Server): void {
    if (this.wss) return;

    // Use noServer mode to handle authentication during upgrade
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      if (url.pathname !== '/ws') return;

      const token = url.searchParams.get('token') || req.headers.authorization?.replace('Bearer ', '');
      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      try {
        const user = await this.verifySessionToken(token);
        if (!user) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }

        const allowedCandidateIds = await this.resolveCandidateScope(user.email, user.role);

        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          const client: AuthenticatedClient = {
            ws,
            email: user.email,
            role: user.role,
            allowedCandidateIds,
          };
          this.clients.add(client);
          log.info(`[WebSocket] 🔌 Authenticated ${user.role} (${user.email}) connected. Active: ${this.clients.size}`);

          ws.send(JSON.stringify({ type: 'CONNECTED', role: user.role, timestamp: new Date().toISOString() }));

          ws.on('close', () => {
            this.clients.delete(client);
          });
          ws.on('error', () => {
            this.clients.delete(client);
          });
        });
      } catch (err: any) {
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      }
    });
  }

  public broadcast(message: WebSocketMessage): void {
    const payload = JSON.stringify(message);
    const targetApplywizzId = (message as any).applywizzId?.toUpperCase();

    for (const client of this.clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      // Access Control Filter:
      // Admins and Devs receive all events
      if (client.allowedCandidateIds === null) {
        client.ws.send(payload);
        continue;
      }

      // If event is specific to a candidate, check authorization
      if (targetApplywizzId) {
        if (client.allowedCandidateIds.has(targetApplywizzId)) {
          client.ws.send(payload);
        }
      } else {
        // Generic status changes without candidate ID: send only if unrestricted
        if (client.role === 'admin' || client.role === 'dev') {
          client.ws.send(payload);
        }
      }
    }
  }
}
```

---

### 4.4 Purge Admin Profile Hydration Loop

**Action:** Delete the destructive loop entirely.  
1. **Frontend (`dashboard/App.tsx`):**
   - Delete `ensureAdminHydrated` callback (lines 215–233).
   - Delete `isAuthHydrating` state variable and loading spinner (lines 219, 231).
   - Remove `ensureAdminHydrated` from `useEffect` dependencies (line 332).
2. **Backend (`src/server/routes/auth.ts`):**
   - Delete `POST /api/auth/hydrate-admin` endpoint (lines 1050–1089).
3. **Backend (`src/server/routes/candidates.ts`):**
   - Delete calls to `hydrateAdminProfilesFromWorkHistory` (line 316).
4. **Service File (`src/services/adminProfileHydrate.ts`):**
   - Delete file entirely.

---

## 5. Phase 2: Database-Driven Scoping & Backend Pushdown

### 5.1 Decoupling Dashboard Routes from Work History API

Empirical DB2 audit confirms:
- **`gh_candidate_applications`:** **1,313 / 1,313 (100%)** applications have `assigned_ca_email` populated in PostgreSQL.
- **`profiles`:** 385 / 389 profiles have `ca_email` populated (the remaining 4 are unassigned sample records with 0 applications).

**Resolution:**
All dashboard reads (`/api/candidates`, `/api/applications`, `/api/manager/*`) query PostgreSQL directly using `assigned_ca_email = userEmail` and `profiles.ca_email = userEmail`.
External Work History API is moved strictly to background CSV ingestion and reconciliation scripts.

---

### 5.2 Migration 039: Index `idx_profiles_ca_email`

Create migration file: `src/db/migrations/039_idx_profiles_ca_email.sql`

```sql
-- Migration 039: Add index on profiles(ca_email) for high-performance dashboard access resolution
-- Prevents sequential table scans during operator and manager candidate lookups.
CREATE INDEX IF NOT EXISTS idx_profiles_ca_email ON profiles(ca_email);
```

---

### 5.3 Operator Workflow Protection & Partitioned DTOs

**The Iron Rule:** `dashboard/FormRenderer.tsx` requires `resolved_fields`, `user_inputs`, and manual edit flags for single-application verification.  
**Implementation:**
- `/api/applications` (Queue list): Return `ApplicationSummaryDto` (16 scalar columns).
- `/api/applications/:id` (Single application review): Return `ApplicationDetailDto` (Full schema including `resolved_fields`).
- `/api/candidates/:id/jobs`: Return `ApplicationDetailDto` enriched with template dropdown choices and options. All dropdown rendering and operator answer editing in `FormRenderer.tsx` remain 100% functional.

---

### 5.4 Manager Application & Queue Query Consolidation

**File:** `src/server/routes/manager.ts:686-746`  
**Problem:** `GET /api/manager/queue` executes 3 separate unbounded `listApplications()` queries (`QUEUED`, `APPLYING`, `OTP_REQUIRED`), loading thousands of full rows into Node.js memory and filtering in JS.  
**Surgical Fix:** Consolidate into 1 SQL query with status filter and manager team CA scoping:

```typescript
// Consolidated Manager Queue Query
const teamCas = await getTeamOperatorEmails(managerEmail);
const { data, error } = await getDbClient()
  .from('gh_candidate_applications')
  .select('id, applywizz_id, job_url, company_name, job_title, status, assigned_ca_email, created_at, updated_at')
  .in('assigned_ca_email', teamCas)
  .in('status', ['QUEUED', 'APPLYING', 'OTP_REQUIRED'])
  .order('created_at', { ascending: false })
  .limit(100);
```

---

### 5.5 Admin Application Search Pushdown

**File:** `src/server/routes/adminDashboard.ts:402-456`  
**Problem:** Route calls `.range(offset, offset + limit - 1)` first, then applies `q.filter(...)` in JavaScript. Matches on row 51+ are invisible, and the returned count ignores the query.  
**Surgical Fix:** Push `.or(...)` filter into Supabase query before pagination:

```typescript
let query = getDbClient()
  .from('gh_candidate_applications')
  .select('id, applywizz_id, job_url, company_name, job_title, status, assigned_ca_email, created_at', { count: 'exact' });

if (searchQuery) {
  const s = searchQuery.replace(/[%,_]/g, ''); // Sanitize wildcards
  query = query.or(`company_name.ilike.%${s}%,job_title.ilike.%${s}%,applywizz_id.ilike.%${s}%,assigned_ca_email.ilike.%${s}%`);
}

query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
```

---

## 6. Phase 3: Realtime Consolidation & Poller Pacification

### 6.1 Killing Redundant Badge (2s) and Proof (3s) Interval Polling

**Files:** `dashboard/components/ApplicationStatusBadge.tsx:67-110`, `dashboard/components/SubmissionControls.tsx:148-152`  
**Action:**
1. Delete `setInterval` block from `ApplicationStatusBadge.tsx`. The component already receives `onStatusChange` props and listens to parent application state.
2. Delete `setInterval` block from `SubmissionControls.tsx`.
3. When the queue worker captures email proof or changes status, it emits `APPLICATION_STATUS_CHANGED` via WebSocket with `proof_email_url` and `proof_email_json`. The client consumes the WebSocket event directly.

---

### 6.2 Paced Fallback Poller in `App.tsx`

**File:** `dashboard/App.tsx:334-342`  
**Changes:**
- Disconnected interval: **15,000ms (15s)**.
- Connected interval: **45,000ms (45s)**.
- Gate on page visibility:

```typescript
useEffect(() => {
  if (!currentUser) return;
  const intervalMs = wsConnected ? 45000 : 15000;
  const pollInterval = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return; // Pause when tab is backgrounded
    }
    fetchInitialData(true, selectedDate);
    fetchNotifications(selectedDate);
  }, intervalMs);
  return () => clearInterval(pollInterval);
}, [currentUser, selectedDate, wsConnected, fetchInitialData, fetchNotifications]);
```

---

### 6.3 Stabilizing WebSocket in `App.tsx`

**File:** `dashboard/App.tsx:550-560`  
**Problem:** `useEffect` dependency array includes `[selectedCandidateId, selectedJobUrl]`. Clicking any candidate or job tears down the socket and reconnects.  
**Surgical Fix:** Store `selectedCandidateId` and `selectedJobUrl` in React `useRef`s (`selectedCandidateRef`, `selectedJobRef`). Read from refs inside the WebSocket message handler. Remove selection states from the `useEffect` dependency array.

---

### 6.4 Adaptive Ingest Polling in `AdminDashboard.tsx`

**File:** `dashboard/components/AdminDashboard.tsx:581-600`  
**Problem:** Polls `/api/admin/ingest-status` every 3 seconds unconditionally.  
**Surgical Fix:** Poll at 3s **only** when `ingestRun?.running === true`. When idle, poll once on mount or when an upload is triggered, then halt.

---

### 6.5 Dedicated Client Notification Dismissal Utility (`localStorage`)

**Files:** `src/db/applications/notifications.ts:16-58`, `dashboard/utils/notificationDismissals.ts`, `dashboard/App.tsx`  
**Action:**
1. **Delete Server State:** Remove `cache/dismissed_notifications.json`, `loadDismissedNotificationIds()`, `saveDismissedNotificationIds()`, and in-memory `dismissedNotificationIds` set.
2. **Dedicated Client Utility Module:** Create `dashboard/utils/notificationDismissals.ts` for clean, isolated client persistence:

```typescript
// dashboard/utils/notificationDismissals.ts

const DISMISSED_KEY = 'applywizz_dismissed_notifications';

export function getDismissedNotificationIds(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return new Set();
  }
}

export function dismissNotificationId(id: string): void {
  const current = getDismissedNotificationIds();
  current.add(id);
  localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(current)));
}

export function dismissAllNotificationIds(ids: string[]): void {
  const current = getDismissedNotificationIds();
  for (const id of ids) current.add(id);
  localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(current)));
}

export function filterActiveNotifications<T extends { id: string }>(items: T[]): T[] {
  const dismissed = getDismissedNotificationIds();
  return items.filter((item) => !dismissed.has(item.id));
}
```

3. **Multi-Instance Safety:** Eliminates cross-user notification hiding and Railway multi-instance state conflicts.

---

## 7. Phase 4: Frontend Debloat, Date Contract & Health Engine

### 7.1 Admin Date Contract: `[ Today | Lifetime | Custom Date ]`

**Files:** `src/server/routes/adminDashboard.ts:249-282`, `dashboard/components/AdminDashboard.tsx`  
**Problem:** Admin date picker sends `?date=...` to `/managers` and `/operators`, but backend ignores date and returns lifetime counts.  
**Surgical Fix:** Implement unified 3-way toggle contract backed by `gh_application_stats_daily` rollups:
- `Today`: Query rollup for `date = CURRENT_DATE` (IST).
- `Lifetime`: Aggregate rollup across all dates (`SELECT sum(...) GROUP BY manager_email / operator_email`).
- `Custom Date`: Query rollup for `date = selectedDate`.

---

### 7.2 Removing Blocked External Font Requests

**File:** `vite.config.ts:23-25, 49-51, 75-77, 101-103`  
**Problem:** Google Fonts `<link rel="preconnect" href="https://fonts.googleapis.com">` is blocked by dashboard CSP, triggering browser console errors on every load.  
**Surgical Fix:** Remove Google Fonts links from HTML transform tags. Fall back cleanly to system font stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`).

---

### 7.3 Concurrency & Response Caching in System Health Probes

**File:** `src/server/healthSnapshot.ts:77-185`  
**Problem:** Database, Storage, Zoho, and ApplyWizz probes are executed sequentially, adding 800ms–2,000ms latency to Dev dashboard.  
**Surgical Fix:**
1. Execute probes concurrently using `Promise.allSettled()`.
2. Add in-memory response cache with 10-second TTL (`cachedHealthSnapshot`, `lastHealthCheckTimestamp`). Return cached snapshot for rapid tab switches.

---

### 7.4 Dead Code Elimination Ledger

| File to Delete | Lines of Code | Reason |
|---|---|---|
| `src/services/adminProfileHydrate.ts` | ~27 lines | Destructive hydration loop. |
| `src/server/workHistoryCache.ts` | ~80 lines | Dead in-memory cache once dashboard is DB-driven. |
| `src/server/workHistorySpan.ts` | ~170 lines | Dead date-span merge module once dashboard is DB-driven. |
| `dashboard/hooks/useDashboardState.ts` | ~120 lines | Unused duplicate state hook. |

---

## 8. Blast Radius Analysis & Safety Proofs (`/pstack:blast-radius`)

### Change 1: Empty-Scope Data Leak Fix
- **Risk:** Setting `allowedCandidateIds = []` breaks legitimate queries for unassigned operators.
- **The One Safety Fact:** **An operator with 0 assigned candidates MUST legitimately see 0 notifications and 0 application statistics.**
- **Proof Level:** **Level 4 (Executed Test & Reproduction)**
  - Audit verified `src/db/applications/notifications.ts:84-103` explicitly treated `[].length > 0 === false` as `null` filter.
  - Adding `if (filter.allowedCandidateIds !== undefined && filter.allowedCandidateIds.length === 0) return [];` guarantees complete data isolation without touching unrestricted admin paths.

### Change 2: Merge-Safe `upsertProfile`
- **Risk:** A caller intentionally wants to set a non-null database value back to `null`.
- **The One Safety Fact:** **Grep across all 12 callers in the entire codebase confirms NO caller intends to clear/delete data via `upsertProfile`.**
- **Proof Level:** **Level 4 (Scratch Execution & Caller Audit)**
  - Scratch script verified passing `{ applywizz_id: 'AWL-TEST', client_name: 'Test' }` previously overwrote 15 columns with `null`.
  - Filtering out `undefined` and `null` values guarantees that existing demographic and contact data remains pristine.

### Change 3: Decoupling Dashboard Routes from Work History API
- **Risk:** An operator logs in, but their assigned candidate does not appear because the database assignment was missing.
- **The One Safety Fact:** **In production DB2, 1,313 / 1,313 (100%) candidate applications already possess `assigned_ca_email`.**
- **Proof Level:** **Level 4 (Database MCP Execution Proof)**
  - Remote DB2 query: `SELECT count(*) as total, count(assigned_ca_email) as with_ca FROM gh_candidate_applications;` returned `total: 1313, with_ca: 1313, without_ca: 0`.
  - Fallback safety guard: Query combines `gh_candidate_applications.assigned_ca_email` with `profiles.ca_email`, covering candidates with or without current applications.

### Change 4: Application Summary Column Trimming & Operator Form Protection
- **Risk:** Trimming `resolved_fields` breaks the Operator answer-review form (`FormRenderer.tsx`).
- **The One Safety Fact:** **Only the active candidate form view (`dashboard/App.tsx:610-618`) renders `FormRenderer.tsx`; summary queues, manager tables, and admin searches only render status badges, titles, and dates.**
- **Proof Level:** **Level 3 (Component Hierarchy & Prop Analysis)**
  - By reserving `resolved_fields` for single-application endpoints (`/api/applications/:id` and candidate job items) and trimming it from list queries (`/api/manager/applications`, `/api/admin/applications`), payload is cut by >90% while the form and dropdown choices remain 100% functional.

### Change 5: Eliminating Badge (2s) and Proof (3s) Interval Polling
- **Risk:** Application status or proof URLs fail to update when an application transitions from `APPLYING` to `APPLIED`.
- **The One Safety Fact:** **The queue worker already emits `APPLICATION_STATUS_CHANGED` and forwards proof URLs over WebSocket upon job completion.**
- **Proof Level:** **Level 3 (Worker Pipeline Audit)**
  - `src/server/ws.ts:111` broadcasts all status changes. Updating the client to handle this event eliminates the need for 50 HTTP requests per minute.

---

## 9. Master Actionable Implementation Ledger

### 🗑️ REMOVE (Total: 14 Items)

| Item | Location | Reason for Removal |
|---|---|---|
| `ensureAdminHydrated` hook | `dashboard/App.tsx:215-233, 327-332` | Triggers destructive profile overwrites on every date click. |
| `POST /api/auth/hydrate-admin` route | `src/server/routes/auth.ts:1050-1089` | Dead endpoint after frontend caller removal. |
| `adminProfileHydrate.ts` | `src/services/adminProfileHydrate.ts` | File contains the destructive hydration loop. |
| `hydrateAdminProfilesFromWorkHistory()` calls | `src/server/routes/candidates.ts:316` | Source of Admin profile data destruction. |
| Work History calls in dashboard routes | `src/server/routes/candidates.ts:309`, `applications.ts:656` | Replaced by direct indexed PostgreSQL queries. |
| `workHistoryCache.ts` | `src/server/workHistoryCache.ts` | 100% dead code (~80 lines) once dashboard is DB-driven. |
| `workHistorySpan.ts` | `src/server/workHistorySpan.ts` | 100% dead code (~170 lines) after DB scoping cutover. |
| `workHistoryUnreachable` banner & state | `dashboard/App.tsx:189, 236, 804-815` | Dead UI state; Work History is no longer queried on dashboard load. |
| `isAuthHydrating` state | `dashboard/App.tsx:219, 231` | Dead loading state tied to removed hydration call. |
| Badge 2s polling interval | `dashboard/components/ApplicationStatusBadge.tsx:67-105` | Redundant HTTP polling; replaced by WebSocket event. |
| Proof 3s polling interval | `dashboard/components/SubmissionControls.tsx:148-152` | Redundant HTTP polling; replaced by WebSocket event. |
| `useDashboardState.ts` | `dashboard/hooks/useDashboardState.ts` | Unused hook duplicating state owned by `App.tsx`. |
| Google Fonts preconnect/stylesheet | `vite.config.ts:23-25, 49-51, 75-77, 101-103` | Blocked by dashboard CSP; causes browser console errors. |
| Local notification dismissal JSON file | `src/db/applications/notifications.ts:16-58` | Shared state desyncs across Railway instances; replaced by `localStorage`. |

---

### ✏️ CHANGE (Total: 10 Items)

| Item | Location | Proposed Surgical Change |
|---|---|---|
| `upsertProfile()` constructor | `src/db/profiles.ts:255-271` | **Merge-Safe:** Strip `null`/`undefined` properties from update payload. |
| Empty-scope leak patch | `src/db/applications/notifications.ts:84`, `statsQueries.ts:263` | Explicitly check `allowedCandidateIds.length === 0` and return empty set immediately. |
| WebSocket authentication & scoping | `src/server/ws.ts:48-130` | Authenticate on upgrade via JWT; filter broadcast events by candidate authorization. |
| WebSocket UI dependency array | `dashboard/App.tsx:560` | Remove `selectedCandidateId` and `selectedJobUrl` to stop socket disconnect/reconnect loops. |
| Offline fallback polling interval | `dashboard/App.tsx:336` | Change interval from 3s to **15s** when WS is offline; **45s** when connected. |
| Admin ingest status polling | `dashboard/components/AdminDashboard.tsx:593` | Poll at 3s **only** while `ingestRun?.running === true`; stop when idle. |
| Admin application search | `src/server/routes/adminDashboard.ts:402-456` | Push search filter into PostgreSQL `.or(...)` **before** `.range()` pagination. |
| Manager queue & application routes | `src/server/routes/manager.ts:686-746` | Push status and CA filters into SQL; consolidate 3 queue reads into 1 query. |
| Health probes concurrency | `src/server/healthSnapshot.ts:77-185` | Execute DB, storage, Zoho, ApplyWizz probes via `Promise.allSettled()` with 10s TTL cache. |
| Admin/Manager date contract | `src/server/routes/adminDashboard.ts:249`, `dashboard/` | Add segmented toggle `[ Today \| Lifetime \| Custom Date ]` backed by daily rollups. |

---

### ➕ ADD (Total: 4 Items)

| Item | Location | Purpose |
|---|---|---|
| PostgreSQL Index Migration | `src/db/migrations/039_idx_profiles_ca_email.sql` | `CREATE INDEX IF NOT EXISTS idx_profiles_ca_email ON profiles(ca_email);` |
| Merge-Safe Profile Unit Test | `tests/mergeSafeProfileUpsert.test.ts` | Verifies partial updates never overwrite existing non-null fields with `NULL`. |
| Empty Scope Security Test | `tests/emptyScopeAccessControl.test.ts` | Verifies `allowedCandidateIds: []` returns 0 notifications and 0 stats. |
| WebSocket Auth & Scoping Test | `tests/webSocketScoping.test.ts` | Verifies unauthenticated sockets are rejected and events are only sent to assigned CAs. |

---

## 10. Phased Implementation Roadmap & Verification Gates

```
Phase 1: Access Control & Data Integrity (P0 Gate - Non-negotiable Prerequisite)
   ├── 1.1: Merge-Safe upsertProfile() + Unit Test (tests/mergeSafeProfileUpsert.test.ts)
   ├── 1.2: Empty-Scope Patch in Notifications & Stats + Security Test (tests/emptyScopeAccessControl.test.ts)
   ├── 1.3: WebSocket Upgrade Authentication & Candidate Scoping + Auth Test (tests/webSocketScoping.test.ts)
   └── 1.4: Purge Admin Profile Hydration (Delete route, ensureAdminHydrated, and adminProfileHydrate.ts)
              │
              ▼ [GATE 1: npm test passes, 0 scope leaks, 0 destructive writes]
Phase 2: Database-Driven Scoping & Backend Pushdown (P1)
   ├── 2.1: Migration 039 (idx_profiles_ca_email)
   ├── 2.2: Decouple candidates.ts & applications.ts from Work History (Use DB-only scoping)
   ├── 2.3: Partitioned DTOs (16-scalar list projection; preserve full schema for FormRenderer)
   ├── 2.4: Push Admin Search into SQL before Pagination
   └── 2.5: Manager Queue SQL Pushdown (Consolidate 3 queries into 1)
              │
              ▼ [GATE 2: FormRenderer review intact, TTFB < 100ms, payload < 35KB]
Phase 3: Realtime Consolidation & Poller Pacification (P1)
   ├── 3.1: Stabilize App.tsx WebSocket (Decouple from selection dependencies using refs)
   ├── 3.2: Kill Badge (2s) and Proof (3s) Interval Polling in Components
   ├── 3.3: Pace Fallback Poller to 15s (Disconnected) / 45s (Connected) + Visibility Gating
   ├── 3.4: Adaptive Admin Ingest Poller (Poll only while running, 0 req/min when idle)
   └── 3.5: Migrate Notification Dismissal to Browser localStorage (dashboard/utils/notificationDismissals.ts)
              │
              ▼ [GATE 3: Zero redundant polling loops, WebSocket events verify proof delivery]
Phase 4: Frontend Debloat & Asset Optimization (P2)
   ├── 4.1: Remove Blocked Google Font Requests from vite.config.ts (Clean CSP)
   ├── 4.2: Implement [ Today | Lifetime | Custom Date ] Toggle Contract
   ├── 4.3: Concurrency in Health Probes & Dev Snapshot Caching (10s TTL)
   └── 4.4: Purge Dead Files (workHistoryCache, workHistorySpan, useDashboardState)
              │
              ▼ [GATE 4: Full Suite Green: npm test, npm run typecheck:dashboard, production build]
```

### The Verification Iron Gate
1. **Rule 12 Compliance:** Zero changes to the 5-tier resolver or Playwright submission engines.
2. **Phase 1 Verification:** Run `npm test` and verify that security tests (`emptyScopeAccessControl.test.ts`, `mergeSafeProfileUpsert.test.ts`) pass cleanly before beginning Phase 2.
3. **Phase 2 Verification:** Query production DB2 via Supabase MCP to confirm 100% CA assignment coverage before switching dashboard scoping to direct PostgreSQL.
4. **Final Gate:** Full test suite (118 unit tests, 32/32 e2e checkpoints), typecheck clean (`npm run typecheck:dashboard`), and production build verification (`npx cross-env NODE_ENV=production vite build`).
