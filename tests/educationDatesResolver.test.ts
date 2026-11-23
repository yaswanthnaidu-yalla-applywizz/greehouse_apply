import { describe, it, expect } from 'vitest';
import { extractEducationDateSubfield, extractEducationDateSubfields } from '../src/resolver/educationDates.js';
import { resolveTier2 } from '../src/resolver/tier2ResumeParse.js';
import AnswerResolver from '../src/resolver/answerResolver.js';
import type { ScannedField } from '../src/types/index.js';

describe('extractEducationDateSubfield', () => {
  const bachelorsEdu = [
    {
      institution: 'San Jose State University',
      degree: 'Bachelor of Science in Computer Science',
      year: '2022',
    },
  ];

  const mastersEdu = [
    {
      institution: 'Stanford University',
      degree: 'Master of Science in Software Engineering',
      year: '2024',
    },
  ];

  const numericEdu = [
    {
      institution: 'UC Berkeley',
      degree: 'Bachelor of Arts',
      year: 2020,
    },
  ];

  const explicitDatesEdu = [
    {
      institution: 'MIT',
      degree: 'B.S.',
      start_year: '2017',
      end_year: '2021',
      start_month: 'August',
      end_month: 'June',
    },
  ];

  it('extracts end date year from graduation year string', () => {
    const result = extractEducationDateSubfield('End date year', 'end_date_year', 'education_end_year', bachelorsEdu);
    expect(result).not.toBeNull();
    expect(result?.value).toBe('2022');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it('extracts end date year from numeric year in education fact', () => {
    const result = extractEducationDateSubfield('Graduation Year', 'grad_year', 'gradYear', numericEdu);
    expect(result).not.toBeNull();
    expect(result?.value).toBe('2020');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it('calculates start year as gradYear - 4 for Bachelors degree', () => {
    const result = extractEducationDateSubfield('Start date year', 'start_date_year', 'education_start_year', bachelorsEdu);
    expect(result).not.toBeNull();
    expect(result?.value).toBe('2018');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('calculates start year as gradYear - 2 for Masters degree', () => {
    const result = extractEducationDateSubfield('Start date year', 'start_date_year', 'education_start_year', mastersEdu);
    expect(result).not.toBeNull();
    expect(result?.value).toBe('2022');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('uses explicit start year and end year when present in facts', () => {
    const startRes = extractEducationDateSubfield('From year', 'from_year', 'start-year--0', explicitDatesEdu);
    expect(startRes?.value).toBe('2017');

    const endRes = extractEducationDateSubfield('To year', 'to_year', 'end-year--0', explicitDatesEdu);
    expect(endRes?.value).toBe('2021');
  });

  it('falls back to standard academic September for start month when missing', () => {
    const result = extractEducationDateSubfield('Start date month', 'start_date_month', 'education_start_month', bachelorsEdu);
    expect(result).not.toBeNull();
    expect(result?.value).toBe('September');
    expect(result?.confidence).toBe(0.85);
  });

  it('falls back to standard academic May for end month when missing', () => {
    const result = extractEducationDateSubfield('End date month', 'end_date_month', 'education_end_month', bachelorsEdu);
    expect(result).not.toBeNull();
    expect(result?.value).toBe('May');
    expect(result?.confidence).toBe(0.85);
  });

  it('uses explicit start and end months when present in facts', () => {
    const startMonth = extractEducationDateSubfield('Start date month', 'start_date_month', 'start-month--0', explicitDatesEdu);
    expect(startMonth?.value).toBe('August');

    const endMonth = extractEducationDateSubfield('End date month', 'end_date_month', 'end-month--0', explicitDatesEdu);
    expect(endMonth?.value).toBe('June');
  });

  it('aligns months to numeric dropdown options when provided', () => {
    const monthOptions = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
    const startRes = extractEducationDateSubfield('Start date month', undefined, undefined, bachelorsEdu, monthOptions);
    expect(startRes?.value).toBe('09');

    const endRes = extractEducationDateSubfield('End date month', undefined, undefined, bachelorsEdu, monthOptions);
    expect(endRes?.value).toBe('05');
  });

  it('supports extractEducationDateSubfields alias', () => {
    const result = extractEducationDateSubfields('End date year', bachelorsEdu);
    expect(result?.value).toBe('2022');
  });

  it('returns null when no education facts are provided or have no year', () => {
    expect(extractEducationDateSubfield('Start date year', undefined, undefined, [])).toBeNull();
    expect(extractEducationDateSubfield('End date year', undefined, undefined, undefined)).toBeNull();
    expect(extractEducationDateSubfield('Start date year', undefined, undefined, [{ institution: 'School' }])).toBeNull();
  });

  it('returns null for non-education and non-date fields', () => {
    expect(extractEducationDateSubfield('First Name', 'first_name', 'first_name', bachelorsEdu)).toBeNull();
    expect(extractEducationDateSubfield('LinkedIn Profile', 'linkedin', 'linkedin', bachelorsEdu)).toBeNull();
    expect(extractEducationDateSubfield('Phone Number', 'phone', 'phone', bachelorsEdu)).toBeNull();
  });
});

describe('Tier 2 Resume Parse Integration', () => {
  const dummyResume: any = {
    applywizz_id: 'test-cand',
    raw_text: 'Education\nSan Jose State University\nBachelor of Science in Computer Science 2022',
    structured: {
      skills: ['TypeScript'],
      experience: [],
      education: [
        {
          institution: 'San Jose State University',
          degree: 'Bachelor of Science in Computer Science',
          year: '2022',
        },
      ],
      rawSections: {},
    },
    parse_failed: false,
  };

  it('resolves Start date year through resolveTier2', async () => {
    const field: ScannedField = {
      fieldId: 'education_attributes--start_date_year',
      name: 'start_date_year',
      label: 'Start date year',
      type: 'text',
      isRequired: true,
    };
    const resolved = await resolveTier2('test-cand', field, dummyResume);
    expect(resolved).not.toBeNull();
    expect(resolved?.value).toBe('2018');
    expect(resolved?.source).toBe('resume_parse');
    expect(resolved?.resolvedByTier).toBe(2);
  });

  it('resolves End date year through resolveTier2', async () => {
    const field: ScannedField = {
      fieldId: 'education_attributes--end_date_year',
      name: 'end_date_year',
      label: 'End date year',
      type: 'text',
      isRequired: true,
    };
    const resolved = await resolveTier2('test-cand', field, dummyResume);
    expect(resolved).not.toBeNull();
    expect(resolved?.value).toBe('2022');
    expect(resolved?.source).toBe('resume_parse');
    expect(resolved?.resolvedByTier).toBe(2);
  });

  it('resolves Start date month with academic fallback through resolveTier2', async () => {
    const field: ScannedField = {
      fieldId: 'education_attributes--start_date_month',
      name: 'start_date_month',
      label: 'Start date month',
      type: 'text',
      isRequired: true,
    };
    const resolved = await resolveTier2('test-cand', field, dummyResume);
    expect(resolved).not.toBeNull();
    expect(resolved?.value).toBe('September');
    expect(resolved?.source).toBe('resume_parse');
    expect(resolved?.resolvedByTier).toBe(2);
  });

  it('resolves End date month with academic fallback through resolveTier2', async () => {
    const field: ScannedField = {
      fieldId: 'education_attributes--end_date_month',
      name: 'end_date_month',
      label: 'End date month',
      type: 'text',
      isRequired: true,
    };
    const resolved = await resolveTier2('test-cand', field, dummyResume);
    expect(resolved).not.toBeNull();
    expect(resolved?.value).toBe('May');
    expect(resolved?.source).toBe('resume_parse');
    expect(resolved?.resolvedByTier).toBe(2);
  });
});

describe('AnswerResolver Integration', () => {
  const dummyProfile: any = {
    applywizz_id: 'cand-123',
    client_name: 'John Doe',
    email: 'john@example.com',
    education: [],
  };

  const dummyResume: any = {
    applywizz_id: 'cand-123',
    raw_text: 'Stanford University\nMaster of Science 2024',
    structured: {
      skills: [],
      experience: [],
      education: [
        {
          institution: 'Stanford University',
          degree: 'Master of Science',
          year: '2024',
        },
      ],
      rawSections: {},
    },
    parse_failed: false,
  };

  it('resolves education date fields via Tier 2 without short-circuiting to unresolved', async () => {
    const resolver = new AnswerResolver();
    const field: ScannedField = {
      fieldId: 'education_attributes--end_date_year',
      name: 'end_date_year',
      label: 'End date year',
      type: 'text',
      isRequired: true,
    };

    const resolved = await resolver.resolveField('cand-123', field, {
      profile: dummyProfile,
      parsedResume: dummyResume,
    });

    expect(resolved.value).toBe('2024');
    expect(resolved.source).toBe('resume_parse');
    expect(resolved.resolvedByTier).toBe(2);
  });

  it('resolves education start year via Tier 2 calculated for Masters', async () => {
    const resolver = new AnswerResolver();
    const field: ScannedField = {
      fieldId: 'education_attributes--start_date_year',
      name: 'start_date_year',
      label: 'Start date year',
      type: 'text',
      isRequired: true,
    };

    const resolved = await resolver.resolveField('cand-123', field, {
      profile: dummyProfile,
      parsedResume: dummyResume,
    });

    expect(resolved.value).toBe('2022');
    expect(resolved.source).toBe('resume_parse');
    expect(resolved.resolvedByTier).toBe(2);
  });
});
