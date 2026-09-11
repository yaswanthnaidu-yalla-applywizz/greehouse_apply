-- ============================================================================
-- Phase V2-1: Greenhouse V2 Supabase Schema DDL
-- File: src/db/schema.sql
-- ============================================================================

-- Enable pgcrypto / uuid generation if not already enabled
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. profiles — Candidate Master Data
-- Synced from ApplyWizz API and populated during V1 migration / Tier 4 refetch
-- ============================================================================
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    applywizz_id TEXT UNIQUE NOT NULL,                  -- e.g. "AWL-36144"
    client_name TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    email TEXT,                                          -- Legacy contact email (prefer company_email)
    company_email TEXT,                                  -- ApplyWizz company email (always used for forms)
    phone TEXT,
    location TEXT,
    linkedin_url TEXT,
    website_url TEXT,
    github_url TEXT,
    work_authorization TEXT,                             -- "US Citizen" | "Green Card" | "H1B" | "F1 OPT"
    requires_sponsorship BOOLEAN DEFAULT false,
    education JSONB DEFAULT '[]'::jsonb,                -- Array<{ institution, degree, fieldOfStudy, graduationYear }>
    work_experience JSONB DEFAULT '[]'::jsonb,          -- Array<{ company, title, startDate, endDate, description }>
    resume_url TEXT,                                     -- Original ApplyWizz remote resume download URL
    resume_text TEXT,                                    -- Full parsed text from resume
    resume_facts JSONB DEFAULT '{}'::jsonb,             -- Structured facts (skills, experience, projects)
    raw_api_payload JSONB,                               -- Full API response stored for debugging & demographics
    zoho_connected BOOLEAN NOT NULL DEFAULT false,       -- Zoho Mail Reader connector mailbox status
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_applywizz_id ON profiles(applywizz_id);
CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles(email);
CREATE INDEX IF NOT EXISTS idx_profiles_company_email ON profiles(company_email);

-- ============================================================================
-- 2. scanned_job_templates — Greenhouse Form Schema Cache
-- Migrated from output/scanned_jobs.json; upserted by Branch 1 scanner
-- ============================================================================
CREATE TABLE IF NOT EXISTS scanned_job_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_url TEXT UNIQUE NOT NULL,
    company_name TEXT,
    job_title TEXT,
    fields_schema JSONB NOT NULL,                       -- Array<ScannedField>
    field_count INTEGER GENERATED ALWAYS AS (jsonb_array_length(fields_schema)) STORED,
    is_expired BOOLEAN DEFAULT false,
    scanned_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_templates_job_url ON scanned_job_templates(job_url);
CREATE INDEX IF NOT EXISTS idx_templates_field_count ON scanned_job_templates(field_count);

-- ============================================================================
-- 3. candidate_qa_bank — Historical Answer Bank
-- Persistent Q&A memory populated by LLM (Tier 5) and manual operator edits
-- ============================================================================
CREATE TABLE IF NOT EXISTS candidate_qa_bank (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    applywizz_id TEXT NOT NULL REFERENCES profiles(applywizz_id) ON DELETE CASCADE,
    question_fingerprint TEXT NOT NULL,                  -- SHA-256(normalized label + type)[0:16]
    question_label TEXT NOT NULL,                       -- Human-readable label for debugging & fuzzy search
    field_type TEXT NOT NULL,                           -- text | textarea | select | radio | checkbox
    value TEXT NOT NULL,                                -- The resolved answer string
    source TEXT NOT NULL CHECK (source IN ('ai', 'manual')),
    confidence NUMERIC(4,3) DEFAULT 1.000,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT uq_candidate_qa_fingerprint UNIQUE(applywizz_id, question_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_qa_bank_applywizz ON candidate_qa_bank(applywizz_id);
CREATE INDEX IF NOT EXISTS idx_qa_bank_fingerprint ON candidate_qa_bank(question_fingerprint);

-- ============================================================================
-- 5. candidate_applications — Application State & Verification Proofs
-- Tracks lifecycle from resolution through dry-run and verified submission
-- ============================================================================
CREATE TABLE IF NOT EXISTS candidate_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    applywizz_id TEXT NOT NULL REFERENCES profiles(applywizz_id) ON DELETE CASCADE,
    job_url TEXT NOT NULL,
    company_name TEXT,
    job_title TEXT,
    status TEXT NOT NULL DEFAULT 'READY_FOR_REVIEW'
        CHECK (status IN (
            'READY_FOR_REVIEW',
            'DRY_RUN_COMPLETE',
            'QUEUED',
            'APPLYING',
            'APPLIED',
            'FAILED',
            'EXPIRED',
            'OTP_REQUIRED',
            'CAPTCHA_TIMEOUT',
            'EMAIL_PROOF_PENDING'
        )),
    submission_order INTEGER,                            -- Global FIFO sequence number for daemon queue
    assigned_ca_email TEXT,                              -- Assigned Campus Ambassador email for user isolation
    has_manual_edits BOOLEAN DEFAULT false,              -- True if operator edited any field; prioritized to end of queue
    reviewed_at TIMESTAMPTZ,                             -- Timestamp when operator reviewed/edited
    resolved_fields JSONB NOT NULL,                     -- Array<ResolvedField> snapshot
    proof_web_url TEXT,                                  -- Supabase Storage signed/public URL of confirmation screenshot
    proof_captured_at TIMESTAMPTZ,
    proof_failed_url TEXT,                               -- Supabase Storage signed URL of failure screenshot
    proof_failed_captured_at TIMESTAMPTZ,
    proof_email_url TEXT,                                -- Legacy screenshot URL (deprecated; use proof_email_json)
    proof_email_json JSONB,                              -- Parsed confirmation email { from, subject, received_at, body_text }
    proof_email_captured_at TIMESTAMPTZ,
    email_proof_status TEXT CHECK (email_proof_status IN ('pending', 'captured', 'timed_out', 'manual_review_needed')),
    manual_email_review BOOLEAN DEFAULT false,          -- True if 10m auto-polling completed without email match
    email_proof_attempted_at TIMESTAMPTZ,
    error_message TEXT,                                 -- Populated on FAILED status
    dry_run_screenshot_url TEXT,                        -- Supabase Storage URL of dry-run form screenshot
    submitted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT uq_candidate_application_pair UNIQUE(applywizz_id, job_url)
);

CREATE INDEX IF NOT EXISTS idx_applications_applywizz ON candidate_applications(applywizz_id);
CREATE INDEX IF NOT EXISTS idx_applications_status ON candidate_applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_queue_order ON candidate_applications(has_manual_edits ASC, reviewed_at ASC);
CREATE INDEX IF NOT EXISTS idx_applications_submission_order ON candidate_applications(submission_order ASC) WHERE status = 'QUEUED';

-- ============================================================================
-- 6. Row Level Security (RLS) Policies for Tables
-- Enables RLS and grants full access policies for backend operations
-- ============================================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE scanned_job_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_qa_bank ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_applications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow full access to profiles" ON profiles;
CREATE POLICY "Allow full access to profiles" ON profiles
    FOR ALL
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "Allow full access to scanned_job_templates" ON scanned_job_templates;
CREATE POLICY "Allow full access to scanned_job_templates" ON scanned_job_templates
    FOR ALL
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "Allow full access to candidate_qa_bank" ON candidate_qa_bank;
CREATE POLICY "Allow full access to candidate_qa_bank" ON candidate_qa_bank
    FOR ALL
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "Allow full access to candidate_applications" ON candidate_applications;
CREATE POLICY "Allow full access to candidate_applications" ON candidate_applications
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- ============================================================================
-- 7. Supabase Storage RLS Policies (storage.objects)
-- ============================================================================
DROP POLICY IF EXISTS "Allow storage access to resumes" ON storage.objects;
CREATE POLICY "Allow storage access to resumes" ON storage.objects
    FOR ALL
    USING (bucket_id = 'resumes')
    WITH CHECK (bucket_id = 'resumes');

DROP POLICY IF EXISTS "Allow storage access to proofs_web" ON storage.objects;
CREATE POLICY "Allow storage access to proofs_web" ON storage.objects
    FOR ALL
    USING (bucket_id = 'proofs_web')
    WITH CHECK (bucket_id = 'proofs_web');

DROP POLICY IF EXISTS "Allow storage access to proofs_dry_run" ON storage.objects;
CREATE POLICY "Allow storage access to proofs_dry_run" ON storage.objects
    FOR ALL
    USING (bucket_id = 'proofs_dry_run')
    WITH CHECK (bucket_id = 'proofs_dry_run');

DROP POLICY IF EXISTS "Allow storage access to proofs_failed" ON storage.objects;
CREATE POLICY "Allow storage access to proofs_failed" ON storage.objects
    FOR ALL
    USING (bucket_id = 'proofs_failed')
    WITH CHECK (bucket_id = 'proofs_failed');

DROP POLICY IF EXISTS "Allow storage access to proofs_mail" ON storage.objects;
CREATE POLICY "Allow storage access to proofs_mail" ON storage.objects
    FOR ALL
    USING (bucket_id = 'proofs_mail')
    WITH CHECK (bucket_id = 'proofs_mail');


