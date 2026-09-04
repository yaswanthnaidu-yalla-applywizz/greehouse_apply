# Backend Schema & Data Specifications — Greenhouse V1 (and V2+ Supabase Migration)

## 1. V1 File-Based Data Structures & Schemas

In V1, all data ingestion, unique link scanning, and answer resolution use structured CSV and JSON files for fast execution.

### 1.1 Input CSV Schema (`greenhouse_only_applywizz_prod(in).csv`)
| Column | Type | Description | Example |
| :--- | :--- | :--- | :--- |
| `Date` | `string` | Ingestion / batch date | `2/9/2026` |
| `Applywizz ID` | `string` | Unique candidate identifier | `AWL-36144` |
| `Client Name` | `string` | Candidate full name | `Sai Palutla` |
| `url` | `string` | Greenhouse job URL | `https://job-boards.greenhouse.io/doordashusa/jobs/7990832` |
| `score` | `number` | Job match score | `0` |
| `scored_jobId` | `string` | Internal job reference ID | `1984_4332117` |
| `status` | `string` | Processing status | `PENDING` |

---

### 1.2 Intermediate Scanned Fields CSV / JSON (`output/scanned_jobs.csv` / `.json`)

This file contains the output of **Branch 1** (Playwright unique link scanning).

```typescript
interface ScannedField {
  fieldId: string;
  name: string;
  type: 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'file' | 'location_autocomplete';
  label: string;
  isRequired: boolean;
  options?: string[]; // Extracted options for select/radio
  metadata?: {
    selector?: string;
    section?: string;
  };
}

interface ScannedJobTemplate {
  jobUrl: string;
  companyName: string;
  jobTitle: string;
  fields: ScannedField[];
  scannedAt: string;
  isExpired: boolean;
}
```

---

### 1.3 ApplyWizz Candidate Profile Schema (Local Cache)

Retrieved from `https://www.apply-wizz.me/api/get-client-details?applywizz_id=AWL-****`:

```typescript
interface ApplyWizzCandidateProfile {
  applywizzId: string;
  clientName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  linkedinUrl: string;
  websiteUrl?: string;
  githubUrl?: string;
  workAuthorization: string; // e.g. "US Citizen", "Green Card", "H1B", "F1 OPT"
  requiresSponsorship: boolean;
  education: Array<{
    institution: string;
    degree: string;
    fieldOfStudy: string;
    graduationYear: string;
  }>;
  workExperience: Array<{
    company: string;
    title: string;
    startDate: string;
    endDate: string;
    description: string;
  }>;
  resumeUrl: string;
  localResumePath: string; // e.g. "./resumes/AWL-36144_resume.pdf"
}
```

---

### 1.4 Resolved Candidate Job Application Schema

Output of **Branch 2** combining candidate data, Branch 1 scanned questions, and LLM synthesis:

```typescript
interface ResolvedField {
  fieldId: string;
  name: string;
  type: string;
  label: string;
  value: string;
  source: 'supabase' | 'ai'; // Strict tagging convention
  confidence: number;
}

interface CandidateJobQueueItem {
  applywizzId: string;
  clientName: string;
  jobUrl: string;
  companyName: string;
  jobTitle: string;
  status: 'READY_FOR_REVIEW' | 'EXPIRED' | 'PENDING';
  formFields: ResolvedField[];
}
```

---

## 2. Future V2+ Supabase Database Migration Schema

When migrating from local files to Supabase in V2+, the following PostgreSQL tables and storage buckets will be utilized:

```sql
-- Profiles table (synced from ApplyWizz API)
CREATE TABLE profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    applywizz_id TEXT UNIQUE NOT NULL,
    client_name TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    email TEXT,
    phone TEXT,
    location TEXT,
    linkedin_url TEXT,
    work_authorization TEXT,
    requires_sponsorship BOOLEAN DEFAULT false,
    resume_storage_path TEXT,
    raw_payload JSONB,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Unique Scanned Greenhouse Job Templates (from Branch 1)
CREATE TABLE scanned_job_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_url TEXT UNIQUE NOT NULL,
    company_name TEXT,
    job_title TEXT,
    fields_schema JSONB NOT NULL,
    is_expired BOOLEAN DEFAULT false,
    scanned_at TIMESTAMPTZ DEFAULT now()
);

-- Candidate Applications Mapping (from Branch 2)
CREATE TABLE candidate_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    template_id UUID REFERENCES scanned_job_templates(id),
    status TEXT DEFAULT 'READY_FOR_REVIEW', -- READY_FOR_REVIEW, APPLIED, FAILED, EXPIRED
    resolved_fields JSONB NOT NULL, -- Array of { fieldId, label, value, source: 'supabase'|'ai'|'manual' }
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(profile_id, template_id)
);

-- Supabase Storage Buckets:
-- 1. 'resumes' -> resumes/{applywizz_id}_master_resume.pdf
-- 2. 'proofs_web' -> proofs/{application_id}_web.png (V2+)
-- 3. 'proofs_email' -> proofs/{application_id}_email.png (V2+)
```
