# Fresh Resume Ingest & Dynamic Submission Renaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure candidate resumes are freshly downloaded from ApplyWizz at every CSV ingestion, the Supabase `resumes` storage bucket is purged, candidate parsed caches are refreshed, and ATS form submissions dynamically rename attached resumes to `Resume_FirstName_LastName_JobRole.pdf` using adapted `fileNameUtils.ts` logic.

**Architecture:**
- Create dynamic resume filename utilities in `src/utils/resumeNaming.ts` adapting `fileNameUtils.ts` for Node.js + Playwright environments.
- Add `purgeResumesBucket()` in `src/db/storage.ts` to wipe the Supabase `resumes` bucket and clear local disk cache.
- Add `invalidateResumeParseCache(applywizzIds)` in `src/resolver/tier2ResumeParse.ts` to clear parsed resume caches.
- Hook bucket purge and fresh resume download/upload into `src/scanner/storageCsvIngestion.ts` and candidate sync, updating `profiles.resume_storage_path`.
- Update `src/submitter/formFiller.ts` and `src/submitter/ashbySubmit.ts` to use `Resume_FirstName_LastName_JobRole.pdf` during Playwright submission.

**Tech Stack:** TypeScript, Node.js, Supabase Storage API, Playwright, Node Test Runner (`node:test`).

## Global Constraints

- Never break existing resolution waterfall (Tiers 1-5).
- Resilient error handling: single candidate S3 download failures must not crash the entire ingestion pipeline.
- Filename generation must work in Node.js (where `document` is undefined) and inside browser contexts.
- Local disk cache (`./resumes/`) must be refreshed so stale files are never reused.
- All tasks must follow TDD: failing test first, minimal implementation to pass, verify green.

## Review Focus

1. `document` is undefined in Node.js runtime → `extractJobRoleFromPage` must accept an optional `pageTitle` or string parameter and not throw ReferenceError.
2. Incomplete or missing candidate names/roles → `buildDocumentFileName` must fall back gracefully to `Resume_Candidate.pdf` without `undefined` in filenames.
3. Empty `resumes` bucket on purge → `purgeResumesBucket` must succeed with 0 deletions without throwing errors.
4. Concurrency & collision in temp directory → renamed resume temp files must not overwrite or conflict during simultaneous worker runs.
5. S3 403 or missing resume on ingest → candidate must be flagged/skipped cleanly, recording failure telemetry.

---

### Task 1: Dynamic Resume Filename Utilities (`src/utils/resumeNaming.ts`)

**Files:**
- Modify: `src/utils/resumeNaming.ts`
- Test: `tests/resumeNaming.test.ts`

**Interfaces:**
- Produces:
  - `extractJobRoleFromPage(pageTitle?: string | null): string`
  - `cleanJobRole(raw: string): string`
  - `sanitizeForFileName(text: string, maxLength?: number): string`
  - `buildDocumentFileName(profileOrName?: CandidateProfileInput | string | null, jobTitleOrPage?: string | null, storedFileName?: string | null, isResume?: boolean): string`
  - `buildResumeSubmissionFilename(clientNameOrProfile?: CandidateProfileInput | string | null, jobTitle?: string | null, companyName?: string | null, fallbackRole?: string | null, storedFileName?: string | null): string`
  - `buildResumeStorageFilename(profileOrName?: CandidateProfileInput | string | null, applywizzId?: string, storedFileName?: string | null): string`

- [ ] **Step 1: Write the failing test**
Update `tests/resumeNaming.test.ts` to test:
- `extractJobRoleFromPage` with various ATS titles ("Software Engineer at Google | Greenhouse", "Senior Product Manager - Stripe - LinkedIn", "Apply | Backend Developer | Workday").
- `sanitizeForFileName` with invalid characters, spaces, and length truncation.
- `buildDocumentFileName` producing `Resume_FirstName_LastName_JobRole.pdf`, `Resume_FirstName_LastName.pdf`, and `Resume_Candidate.pdf`.
- `buildResumeSubmissionFilename` backwards compatibility with existing callers.
- `buildResumeStorageFilename` producing `Resume_FirstName_LastName.pdf`.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx tsx tests/resumeNaming.test.ts`
Expected: FAIL (new functions missing / format assertion failures)

- [ ] **Step 3: Implement adapted `fileNameUtils.ts` in `src/utils/resumeNaming.ts`**
Implement the adapted logic:
- Support Node.js (`pageTitle` parameter) with fallback to `typeof document !== 'undefined' ? document.title : ''`.
- Support multiple profile shapes (`personal.firstName`, `first_name`, `firstName`, `client_name`).
- Return clean `Resume_FirstName_LastName_JobRole.pdf` format.

- [ ] **Step 4: Run test to verify it passes**
Run: `npx tsx tests/resumeNaming.test.ts`
Expected: PASS (all 14+ tests green)

- [ ] **Step 5: Commit**
```bash
git add src/utils/resumeNaming.ts tests/resumeNaming.test.ts
git commit -m "feat(resume): adapt fileNameUtils for dynamic professional resume naming"
```

---

### Task 2: Supabase Storage Resumes Bucket Purge (`src/db/storage.ts`)

**Files:**
- Modify: `src/db/storage.ts`
- Test: `tests/storageResumePurge.test.ts`

**Interfaces:**
- Produces:
  - `purgeResumesBucket(): Promise<{ deletedCount: number; clearedLocalCount: number }>`
  - `resumeStorageFilename(applywizzId: string, profile?: ResumeNamingProfile): string` (updated to `Resume_First_Last.pdf`)

- [ ] **Step 1: Write the failing test**
Create `tests/storageResumePurge.test.ts`:
- Mock or memory DB client with `storage.from('resumes').list()` and `storage.from('resumes').remove()`.
- Test that `purgeResumesBucket()` deletes all objects in the `resumes` bucket.
- Test that local `./resumes/` folder files are also purged.
- Test that empty bucket returns `{ deletedCount: 0 }` without throwing.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx tsx tests/storageResumePurge.test.ts`
Expected: FAIL (purgeResumesBucket is not a function)

- [ ] **Step 3: Implement `purgeResumesBucket` and update `resumeStorageFilename` in `src/db/storage.ts`**
- Implement `purgeResumesBucket`: list all files with pagination, call `storage.from(RESUMES_BUCKET).remove(names)`, clean local `./resumes/` directory.
- Update `resumeStorageFilename` to produce `Resume_FirstName_LastName.pdf` via `buildResumeStorageFilename`.

- [ ] **Step 4: Run test to verify it passes**
Run: `npx tsx tests/storageResumePurge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/db/storage.ts tests/storageResumePurge.test.ts
git commit -m "feat(storage): implement purgeResumesBucket and update storage filename format"
```

---

### Task 3: Invalidate Parsed Resume Cache (`src/resolver/tier2ResumeParse.ts`)

**Files:**
- Modify: `src/resolver/tier2ResumeParse.ts`
- Test: `tests/tier2ResumeCacheInvalidation.test.ts`

**Interfaces:**
- Produces:
  - `invalidateResumeParseCache(applywizzIds: string[]): Promise<number>`

- [ ] **Step 1: Write the failing test**
Create `tests/tier2ResumeCacheInvalidation.test.ts`:
- Verify `invalidateResumeParseCache` deletes rows from `candidate_resume_parsed` where `applywizz_id` matches.
- Verify empty array returns 0 without calling database.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx tsx tests/tier2ResumeCacheInvalidation.test.ts`
Expected: FAIL (invalidateResumeParseCache is not a function)

- [ ] **Step 3: Implement `invalidateResumeParseCache` in `src/resolver/tier2ResumeParse.ts`**
- Execute DELETE query or Supabase `.from('candidate_resume_parsed').delete().in('applywizz_id', applywizzIds)`.

- [ ] **Step 4: Run test to verify it passes**
Run: `npx tsx tests/tier2ResumeCacheInvalidation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/resolver/tier2ResumeParse.ts tests/tier2ResumeCacheInvalidation.test.ts
git commit -m "feat(resolver): add invalidateResumeParseCache for fresh ingest re-parsing"
```

---

### Task 4: Fresh Resume Sync at CSV Ingest (`src/candidate/ensureSupabaseProfile.ts`, `src/scanner/storageCsvIngestion.ts`)

**Files:**
- Modify: `src/candidate/ensureSupabaseProfile.ts`
- Modify: `src/scanner/storageCsvIngestion.ts`
- Test: `tests/freshResumeIngest.test.ts`

**Interfaces:**
- `storageCsvIngestion.ts`:
  - Calls `purgeResumesBucket()` prior to running pipeline.
  - Extracts unique candidate AWL IDs and calls `invalidateResumeParseCache(candidateIds)`.
- `ensureSupabaseProfile.ts`:
  - Adds `forceRefreshResume?: boolean` option to re-download resume even if profile already exists in Supabase.
  - Updates `profiles.resume_storage_path` with the fresh path.

- [ ] **Step 1: Write the failing test**
Create `tests/freshResumeIngest.test.ts`:
- Test that `ensureSupabaseProfile` with `forceRefreshResume: true` downloads and re-uploads resume even when profile exists.
- Test that `storageCsvIngestion` invokes resume bucket purge and cache invalidation.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx tsx tests/freshResumeIngest.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement fresh resume sync and hook into ingestion**
- Update `ensureSupabaseProfile.ts` to support `forceRefreshResume: true`.
- In `storageCsvIngestion.ts`, call `purgeResumesBucket()` and `invalidateResumeParseCache(candidateIds)` before Phase C profile sync.

- [ ] **Step 4: Run test to verify it passes**
Run: `npx tsx tests/freshResumeIngest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/candidate/ensureSupabaseProfile.ts src/scanner/storageCsvIngestion.ts tests/freshResumeIngest.test.ts
git commit -m "feat(ingest): force fresh resume download and storage sync at every ingest"
```

---

### Task 5: Dynamic Renaming During ATS Form Submission (`src/submitter/formFiller.ts`, `src/submitter/ashbySubmit.ts`)

**Files:**
- Modify: `src/submitter/formFiller.ts:71-79, 1434-1439, 2733`
- Modify: `src/submitter/ashbySubmit.ts:353-364`
- Test: `tests/formFillerResumeNaming.test.ts`

**Interfaces:**
- Consumes:
  - `buildResumeSubmissionFilename` / `buildDocumentFileName` from `src/utils/resumeNaming.ts`.
- Behavior:
  - Extract job role using page title and/or job title.
  - Rename temp file to `Resume_FirstName_LastName_JobRole.pdf`.
  - Handle potential temp file collisions cleanly.

- [ ] **Step 1: Write the failing test**
Create `tests/formFillerResumeNaming.test.ts` verifying that `buildResumeFilename` in `formFiller.ts` and `ashbySubmit.ts` produces `Resume_FirstName_LastName_JobRole.pdf` matching live page title and job title.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx tsx tests/formFillerResumeNaming.test.ts`
Expected: FAIL

- [ ] **Step 3: Update `formFiller.ts` and `ashbySubmit.ts`**
- Update `formFiller.ts` `buildResumeFilename` to pass `page.title()` when available.
- Update `ashbySubmit.ts` to pass `page.title()` when available.
- Ensure safe file renaming (handling existing file in tmp directory).

- [ ] **Step 4: Run test to verify it passes**
Run: `npx tsx tests/formFillerResumeNaming.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/submitter/formFiller.ts src/submitter/ashbySubmit.ts tests/formFillerResumeNaming.test.ts
git commit -m "feat(submitter): dynamically name resume files to Resume_First_Last_JobRole during submission"
```

---

### Task 6: Full Verification & Regression Run

**Files:**
- Run all unit tests, vitest tests, and typechecks.

- [ ] **Step 1: Run unit tests**
Run: `npm run test:unit`
Expected: 100% pass across all unit tests

- [ ] **Step 2: Run full TypeScript check**
Run: `npx tsc --noEmit`
Expected: 0 type errors

- [ ] **Step 3: Commit final verification**
```bash
git commit --allow-empty -m "chore: verified full resume fresh ingest and dynamic naming suite green"
```
