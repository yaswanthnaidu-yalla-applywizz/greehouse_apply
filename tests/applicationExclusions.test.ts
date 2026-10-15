import { describe, expect, it } from 'vitest';
import type { ApplyWizzCandidateProfile } from '../src/types/index.js';
import { getApplicationExclusionReasons } from '../src/resolver/applicationExclusions.js';

function profile(overrides: Partial<ApplyWizzCandidateProfile> = {}): ApplyWizzCandidateProfile {
  return {
    applywizzId: 'AWL-1',
    clientName: 'Candidate One',
    firstName: 'Candidate',
    lastName: 'One',
    email: 'candidate@example.com',
    phone: '',
    location: '',
    linkedinUrl: '',
    workAuthorization: '',
    requiresSponsorship: false,
    education: [],
    workExperience: [],
    resumeUrl: '',
    localResumePath: '',
    ...overrides,
  };
}

describe('application company exclusion policy', () => {
  it('parses the JSON-stringified excluded-company list and splits comma-separated entries', () => {
    const candidate = profile({
      raw_api_payload: {
        additional_information: { exclude_companies: '["Adobe,Google,Amazon"]' },
      },
    });
    expect(getApplicationExclusionReasons(candidate, ' Google ')).toEqual(['excluded_company']);
  });

  it('matches exact normalized company names, not substrings', () => {
    const candidate = profile({
      raw_api_payload: {
        additional_information: { exclude_companies: '["Adobe"]' },
      },
    });
    expect(getApplicationExclusionReasons(candidate, 'ADOBE')).toEqual(['excluded_company']);
    expect(getApplicationExclusionReasons(candidate, 'Adobe Systems')).toEqual([]);
  });

  it.each(['not-json', '[]', '[""]'])('ignores malformed or empty excluded-company data: %s', (value) => {
    const candidate = profile({
      raw_api_payload: { additional_information: { exclude_companies: value } },
    });
    expect(getApplicationExclusionReasons(candidate, 'Adobe')).toEqual([]);
  });

  it('accepts an already-decoded excluded-company array', () => {
    const candidate = profile({
      raw_api_payload: {
        additional_information: { exclude_companies: ['Adobe', 'Google'] },
      },
    });
    expect(getApplicationExclusionReasons(candidate, 'Google')).toEqual(['excluded_company']);
  });

  it('matches only the most recent dated cached resume employer', () => {
    const candidate = profile({
      resumeFacts: {
        experience: [
          { company: 'Older Corp', startDate: '2020-01', endDate: '2022-01' },
          { company: 'Current Corp', startDate: '2022-02', endDate: 'Present' },
        ],
      },
    });
    expect(getApplicationExclusionReasons(candidate, 'current   corp')).toEqual(['latest_employer']);
    expect(getApplicationExclusionReasons(candidate, 'Older Corp')).toEqual([]);
  });

  it('does not infer a latest employer from missing or undated resume facts', () => {
    expect(getApplicationExclusionReasons(profile({ resumeFacts: { experience: [] } }), 'Current Corp')).toEqual([]);
    expect(getApplicationExclusionReasons(profile({
      resumeFacts: { experience: [{ company: 'Current Corp', title: 'Engineer' }] },
    }), 'Current Corp')).toEqual([]);
  });

  it('returns both matching company reasons without duplicates', () => {
    const candidate = profile({
      raw_api_payload: {
        additional_information: { exclude_companies: '["Current Corp"]' },
      },
      resumeFacts: {
        experience: [{ company: 'Current Corp', startDate: '2022-01', endDate: 'Present' }],
      },
    });
    expect(getApplicationExclusionReasons(candidate, ' current corp ')).toEqual([
      'excluded_company',
      'latest_employer',
    ]);
  });
});
