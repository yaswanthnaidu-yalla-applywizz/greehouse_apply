import { describe, it, expect, vi } from 'vitest';
import {
  translateTechnicalLabel,
  resolveRemediationAnswer,
  remediateUncommittedFields,
  type RemediationCandidateContext,
} from '../src/submitter/realtimeRemediator.js';

describe('Real-Time Remediator - Human Labels and Circuit Breakers', () => {
  describe('translateTechnicalLabel', () => {
    it('maps known Ashby system tokens to human labels', () => {
      expect(translateTechnicalLabel('_systemfield_name')).toBe('Full Legal Name');
      expect(translateTechnicalLabel('_systemfield_first_name')).toBe('First Name');
      expect(translateTechnicalLabel('_systemfield_last_name')).toBe('Last Name');
      expect(translateTechnicalLabel('_systemfield_email')).toBe('Email Address');
      expect(translateTechnicalLabel('_systemfield_phone')).toBe('Phone Number');
      expect(translateTechnicalLabel('_systemfield_resume')).toBe('Resume');
      expect(translateTechnicalLabel('_systemfield_linkedin_url')).toBe('LinkedIn URL');
      expect(translateTechnicalLabel('_systemfield_website_url')).toBe('Personal Website / Portfolio');
      expect(translateTechnicalLabel('_systemfield_location')).toBe('Current Location');
      expect(translateTechnicalLabel('_systemfield_cover_letter')).toBe('Cover Letter');
    });

    it('cleans and title-cases unknown _systemfield_ tokens', () => {
      expect(translateTechnicalLabel('_systemfield_custom_question_tag')).toBe('Custom question tag');
      expect(translateTechnicalLabel('_systemfield_candidate_note')).toBe('Candidate note');
    });

    it('converts underscore and hyphen technical identifiers into readable words', () => {
      expect(translateTechnicalLabel('candidate_education_degree')).toBe('Candidate education degree');
      expect(translateTechnicalLabel('work_authorization_status')).toBe('Work authorization status');
      expect(translateTechnicalLabel('years-of-experience')).toBe('Years of experience');
    });

    it('leaves standard human labels untouched', () => {
      expect(translateTechnicalLabel('Are you authorized to work in the United States?')).toBe(
        'Are you authorized to work in the United States?'
      );
      expect(translateTechnicalLabel('Current Company')).toBe('Current Company');
    });
  });

  describe('Education Month Deterministic Resolution', () => {
    const dummyContext: RemediationCandidateContext = {
      profile: {
        applywizz_id: 'test-user',
        client_name: 'Test Candidate',
        work_authorization: 'US Citizen',
        requires_sponsorship: false,
      } as any,
      resumeFacts: {
        degrees: ['B.S. in Computer Science (2022)'],
      },
      alreadyResolvedFields: [],
      jobTitle: 'Software Engineer',
      companyName: 'Acme Corp',
    };

    it('resolves graduation/end month to May or June when options are month names', async () => {
      const decision = await resolveRemediationAnswer(
        {
          fieldId: 'education_end_month',
          label: 'Graduation Month',
          type: 'select',
          options: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
        },
        dummyContext
      );

      expect(decision).not.toBeNull();
      expect(decision?.value).toBe('May');
      expect(decision?.confidence).toBeGreaterThanOrEqual(0.95);
      expect(decision?.source).toBe('ai_realtime_remediated');
    });

    it('resolves start month to August or September when options are numeric months', async () => {
      const decision = await resolveRemediationAnswer(
        {
          fieldId: 'education_start_month',
          label: 'Start Month',
          type: 'select',
          options: ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'],
        },
        dummyContext
      );

      expect(decision).not.toBeNull();
      expect(['08', '09']).toContain(decision?.value);
      expect(decision?.confidence).toBeGreaterThanOrEqual(0.95);
    });
  });

  describe('Circuit Breaker Default Elevation', () => {
    it('defaults maxFields to 6 when not explicitly provided', async () => {
      const mockPage: any = {
        locator: vi.fn().mockReturnValue({
          first: () => ({
            count: async () => 0,
          }),
          count: async () => 0,
        }),
      };

      const application: any = {
        id: 'app-1',
        applywizz_id: 'user-1',
        job_url: 'https://jobs.ashbyhq.com/test/job-1',
      };

      const getProfileMock = vi.fn().mockResolvedValue({
        applywizz_id: 'user-1',
        first_name: 'John',
        last_name: 'Doe',
      });

      const uncommittedLabels = [
        'field1',
        'field2',
        'field3',
        'field4',
        'field5',
        'field6',
        'field7',
        'field8',
      ];

      const result = await remediateUncommittedFields(mockPage, uncommittedLabels, application, {
        getProfileFn: getProfileMock,
        getResumeFn: async () => null,
      });

      // Default ceiling was 3, now must be 6
      expect(result.attemptedCount).toBe(6);
    });
  });
});
