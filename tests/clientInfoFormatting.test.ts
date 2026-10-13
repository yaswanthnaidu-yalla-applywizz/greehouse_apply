import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractClientDetails,
  formatEducationList,
  formatExperienceList,
} from '../dashboard/components/ClientInfoDrawer.js';
import type { CandidateDetail } from '../dashboard/types.js';

describe('Client Info Drawer Data Formatting', () => {
  it('extracts primary details and omits missing/empty fields', () => {
    const candidate: CandidateDetail = {
      applywizzId: 'AWL-12345',
      clientName: 'Jane Doe',
      profile: {
        applywizzId: 'AWL-12345',
        clientName: 'Jane Doe',
        email: 'personal@gmail.com',
        phone: '+1-555-0199',
        location: 'San Jose, CA',
        country: 'United States',
        countryCode: '+1',
        linkedinUrl: 'https://linkedin.com/in/janedoe',
        workAuthorization: 'US Citizen',
        requiresSponsorship: false,
        education: [],
        workExperience: [],
        resumeUrl: 'https://example.com/resume.pdf',
        localResumePath: '/tmp/resume.pdf',
      } as any,
      jobs: [],
    };

    const details = extractClientDetails(candidate);
    assert.strictEqual(details.awlId, 'AWL-12345');
    assert.strictEqual(details.name, 'Jane Doe');
    assert.strictEqual(details.phone, '+1-555-0199');
    assert.strictEqual(details.country, 'United States');
    assert.strictEqual(details.location, 'San Jose, CA');
    assert.strictEqual(details.linkedinUrl, 'https://linkedin.com/in/janedoe');
    assert.strictEqual(details.workAuth, 'US Citizen');
    assert.strictEqual(details.sponsorship, 'No (Does not require sponsorship)');
    // Omitted fields should be undefined / null
    assert.strictEqual(details.websiteUrl, null);
    assert.strictEqual(details.githubUrl, null);
  });

  it('formats education objects cleanly and skips malformed records', () => {
    const rawEducation = [
      {
        institution: 'Stanford University',
        degree: 'Master of Science',
        fieldOfStudy: 'Computer Science',
        graduationYear: '2023',
      },
      {
        institution: 'UC Berkeley',
        degree: 'Bachelor of Science',
        fieldOfStudy: '',
        graduationYear: '2021',
      },
    ];

    const formatted = formatEducationList(rawEducation);
    assert.strictEqual(formatted.length, 2);
    assert.strictEqual(formatted[0].degreeAndField, 'Master of Science in Computer Science');
    assert.strictEqual(formatted[0].institution, 'Stanford University');
    assert.strictEqual(formatted[0].year, '2023');

    assert.strictEqual(formatted[1].degreeAndField, 'Bachelor of Science');
    assert.strictEqual(formatted[1].institution, 'UC Berkeley');
    assert.strictEqual(formatted[1].year, '2021');
  });

  it('formats work experience items with companies, titles, and dates', () => {
    const rawExperience = [
      {
        title: 'Senior Software Engineer',
        company: 'Stripe',
        startDate: '2022',
        endDate: 'Present',
        description: 'Led core billing platform scalability projects.',
      },
      {
        title: 'Software Engineer',
        company: 'DoorDash',
        startDate: '2020',
        endDate: '2022',
      },
    ];

    const formatted = formatExperienceList(rawExperience);
    assert.strictEqual(formatted.length, 2);
    assert.strictEqual(formatted[0].titleAndCompany, 'Senior Software Engineer at Stripe');
    assert.strictEqual(formatted[0].dateRange, '2022 – Present');
    assert.strictEqual(formatted[0].description, 'Led core billing platform scalability projects.');

    assert.strictEqual(formatted[1].titleAndCompany, 'Software Engineer at DoorDash');
    assert.strictEqual(formatted[1].dateRange, '2020 – 2022');
    assert.strictEqual(formatted[1].description, null);
  });

  it('returns empty lists when education or experience are missing or empty', () => {
    assert.deepStrictEqual(formatEducationList(undefined), []);
    assert.deepStrictEqual(formatEducationList([]), []);
    assert.deepStrictEqual(formatExperienceList(undefined), []);
    assert.deepStrictEqual(formatExperienceList([]), []);
  });
});
