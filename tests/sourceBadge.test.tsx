import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SourceBadge } from '../dashboard/components/SourceBadge.js';
import type { ResolutionProvenance } from '../src/types/index.js';

describe('SourceBadge Provenance Display', () => {
  it('renders Policy controlled badge when provenance policyId is present', () => {
    const provenance: ResolutionProvenance = {
      family: 'agreement_consent',
      policyId: 'sms-consent',
    };
    const html = renderToStaticMarkup(
      <SourceBadge source="policy" provenance={provenance} />
    );
    expect(html).toContain('Policy');
  });

  it('renders Raw profile controlled badge when evidenceKind is profile_payload', () => {
    const provenance: ResolutionProvenance = {
      family: 'work_authorization',
      evidenceKind: 'profile_payload',
      evidenceKey: 'visa_type',
    };
    const html = renderToStaticMarkup(
      <SourceBadge source="policy" provenance={provenance} />
    );
    expect(html).toContain('Raw profile');
  });

  it('renders Resume controlled badge when evidenceKind is tier2_resume', () => {
    const provenance: ResolutionProvenance = {
      family: 'contact_profile',
      evidenceKind: 'tier2_resume',
    };
    const html = renderToStaticMarkup(
      <SourceBadge source="resume_parse" provenance={provenance} />
    );
    expect(html).toContain('Resume');
  });

  it('renders Employment history controlled badge when evidenceKind is employment_history', () => {
    const provenance: ResolutionProvenance = {
      family: 'employer_history',
      evidenceKind: 'employment_history',
    };
    const html = renderToStaticMarkup(
      <SourceBadge source="supabase" provenance={provenance} />
    );
    expect(html).toContain('Employment history');
  });

  it('renders QA match controlled badge when evidenceKind is qa_match', () => {
    const provenance: ResolutionProvenance = {
      family: 'availability_education',
      evidenceKind: 'qa_match',
    };
    const html = renderToStaticMarkup(
      <SourceBadge source="supabase" provenance={provenance} />
    );
    expect(html).toContain('QA match');
  });

  it('renders Posting location controlled badge when evidenceKind is job_posting_location', () => {
    const provenance: ResolutionProvenance = {
      family: 'workplace_preference',
      evidenceKind: 'job_posting_location',
    };
    const html = renderToStaticMarkup(
      <SourceBadge source="policy" provenance={provenance} />
    );
    expect(html).toContain('Posting location');
  });

  it('renders manual badge when isEdited is true regardless of provenance', () => {
    const provenance: ResolutionProvenance = {
      family: 'workplace_preference',
      evidenceKind: 'job_posting_location',
    };
    const html = renderToStaticMarkup(
      <SourceBadge source="policy" isEdited={true} provenance={provenance} />
    );
    expect(html).toContain('manual');
    expect(html).not.toContain('Posting location');
  });

  it('renders backward-compatible badge for legacy rows without provenance', () => {
    const htmlSupabase = renderToStaticMarkup(
      <SourceBadge source="supabase" confidence={0.9} />
    );
    expect(htmlSupabase).toContain('supabase');

    const htmlUnresolved = renderToStaticMarkup(
      <SourceBadge source="unresolved" />
    );
    expect(htmlUnresolved).toContain('unresolved');
  });
});
