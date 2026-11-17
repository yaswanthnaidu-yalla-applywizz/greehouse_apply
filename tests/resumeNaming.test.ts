import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJobRoleFromPage,
  cleanJobRole,
  sanitizeForFileName,
  buildDocumentFileName,
  buildResumeSubmissionFilename,
  buildResumeStorageFilename,
} from '../src/utils/resumeNaming.js';

describe('resumeNaming - dynamic adapted fileNameUtils', () => {
  describe('extractJobRoleFromPage', () => {
    it('extracts role from "Job Title at Company | Platform"', () => {
      assert.equal(
        extractJobRoleFromPage('Software Engineer at Google | Greenhouse'),
        'Software Engineer'
      );
    });

    it('extracts role from "Job Title - Company - Platform"', () => {
      assert.equal(
        extractJobRoleFromPage('Senior Product Manager - Stripe - LinkedIn'),
        'Senior Product Manager'
      );
    });

    it('extracts role from "Platform | Job Title | Company"', () => {
      assert.equal(
        extractJobRoleFromPage('Apply | Software Engineer | Workday'),
        'Software Engineer'
      );
    });

    it('strips common ATS boilerplate prefixes', () => {
      assert.equal(
        extractJobRoleFromPage('Job Application for Retirement Specialist at Vanguard'),
        'Retirement Specialist'
      );
      assert.equal(
        extractJobRoleFromPage('Apply for Data Analyst at Meta'),
        'Data Analyst'
      );
    });

    it('handles empty or null safely without throwing in Node.js', () => {
      assert.equal(extractJobRoleFromPage(''), '');
      assert.equal(extractJobRoleFromPage(null), '');
      assert.equal(extractJobRoleFromPage(undefined), '');
    });
  });

  describe('cleanJobRole & sanitizeForFileName', () => {
    it('cleans application prefixes', () => {
      assert.equal(cleanJobRole('Job Application for Backend Engineer'), 'Backend Engineer');
      assert.equal(cleanJobRole('Apply to Frontend Lead'), 'Frontend Lead');
    });

    it('sanitizes special characters, replaces spaces with underscores and truncates length', () => {
      assert.equal(sanitizeForFileName('John Doe', 20), 'John_Doe');
      assert.equal(sanitizeForFileName('Senior - Staff C++ Developer (Remote!)', 30), 'Senior_Staff_C_Developer_Remot');
      assert.equal(sanitizeForFileName('___Leading and Trailing___', 30), 'Leading_and_Trailing');
    });
  });

  describe('buildDocumentFileName', () => {
    it('builds Resume_FirstName_LastName_JobRole.pdf when all fields present', () => {
      const filename = buildDocumentFileName(
        { firstName: 'John', lastName: 'Smith' },
        'Software Engineer at Google | Greenhouse'
      );
      assert.equal(filename, 'Resume_John_Smith_Software_Engineer.pdf');
    });

    it('supports profile objects with first_name / last_name or personal sub-object', () => {
      const filename1 = buildDocumentFileName(
        { first_name: 'Jane', last_name: 'Doe' },
        'Senior Product Manager'
      );
      assert.equal(filename1, 'Resume_Jane_Doe_Senior_Product_Manager.pdf');

      const filename2 = buildDocumentFileName(
        { personal: { firstName: 'Alice', lastName: 'Wonder' } },
        'Data Scientist'
      );
      assert.equal(filename2, 'Resume_Alice_Wonder_Data_Scientist.pdf');
    });

    it('supports string client_name and splits into first and last name', () => {
      const filename = buildDocumentFileName('Sai Kiran Akula', 'Data Analyst');
      assert.equal(filename, 'Resume_Sai_Kiran_Akula_Data_Analyst.pdf');
    });

    it('falls back to candidate profile job title when page title is absent', () => {
      const filename = buildDocumentFileName(
        { firstName: 'Bob', lastName: 'Builder', jobTitle: 'DevOps Architect' },
        ''
      );
      assert.equal(filename, 'Resume_Bob_Builder_DevOps_Architect.pdf');
    });

    it('omits role when no job title or profile role is present', () => {
      const filename = buildDocumentFileName({ firstName: 'John', lastName: 'Smith' });
      assert.equal(filename, 'Resume_John_Smith.pdf');
    });

    it('falls back to Candidate when no name is provided', () => {
      assert.equal(buildDocumentFileName(null), 'Resume_Candidate.pdf');
    });

    it('supports cover letters and preserves extensions', () => {
      assert.equal(
        buildDocumentFileName({ firstName: 'John', lastName: 'Doe' }, 'Backend Developer', 'letter.docx', false),
        'CoverLetter_John_Doe_Backend_Developer.docx'
      );
    });
  });

  describe('buildResumeSubmissionFilename backwards compatibility', () => {
    it('builds Resume_FirstName_LastName_JobRole.pdf from legacy parameters', () => {
      const filename = buildResumeSubmissionFilename('John Doe', 'Full Stack Engineer');
      assert.equal(filename, 'Resume_John_Doe_Full_Stack_Engineer.pdf');
    });

    it('handles companyName and fallbackRole', () => {
      const filename = buildResumeSubmissionFilename('Mary Watson', null, 'Stripe', 'Security Engineer');
      assert.equal(filename, 'Resume_Mary_Watson_Security_Engineer.pdf');
    });
  });

  describe('buildResumeStorageFilename', () => {
    it('builds Resume_FirstName_LastName.pdf for Supabase Storage', () => {
      const filename = buildResumeStorageFilename({ firstName: 'Raj', lastName: 'Kumar' }, 'AWL-12345');
      assert.equal(filename, 'Resume_Raj_Kumar.pdf');
    });

    it('falls back to applywizzId when name is missing', () => {
      const filename = buildResumeStorageFilename(null, 'AWL-12345');
      assert.equal(filename, 'Resume_AWL_12345.pdf');
    });
  });
});
