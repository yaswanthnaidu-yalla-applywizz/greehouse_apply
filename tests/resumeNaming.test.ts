import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveResumeDomain,
  sanitizeResumeClientName,
  buildResumeSubmissionFilename,
} from '../src/utils/resumeNaming.js';
import { resumeDomainShortcode, resumeStorageFilename } from '../src/db/storage.js';

describe('resumeNaming', () => {
  describe('resolveResumeDomain', () => {
    it('resolves Full Stack roles accurately to FULL_STACK', () => {
      assert.equal(resolveResumeDomain('Full Stack Engineer'), 'FULL_STACK');
      assert.equal(resolveResumeDomain('Senior Full-Stack Developer'), 'FULL_STACK');
      assert.equal(resolveResumeDomain('Staff FullStack Software Engineer'), 'FULL_STACK');
    });

    it('resolves frontend, backend, and core software engineering roles', () => {
      assert.equal(resolveResumeDomain('Frontend Engineer (React)'), 'FRONTEND');
      assert.equal(resolveResumeDomain('Senior Backend Developer - Go/Node'), 'BACKEND');
      assert.equal(resolveResumeDomain('Software Engineer II'), 'SOFTWARE_ENGINEER');
      assert.equal(resolveResumeDomain('SWE - Infrastructure'), 'DEVOPS');
      assert.equal(resolveResumeDomain('Mobile App Developer (iOS/Android)'), 'MOBILE');
    });

    it('resolves data, ML, and AI roles', () => {
      assert.equal(resolveResumeDomain('Data Engineer'), 'DATA_ENGINEER');
      assert.equal(resolveResumeDomain('Senior Data Analyst'), 'DATA_ANALYST');
      assert.equal(resolveResumeDomain('Lead Data Scientist'), 'DATA_SCIENCE');
      assert.equal(resolveResumeDomain('Machine Learning Engineer'), 'AI_ML');
      assert.equal(resolveResumeDomain('Gen AI Prompt Engineer'), 'AI_ML');
      assert.equal(resolveResumeDomain('Artificial Intelligence Researcher'), 'AI_ML');
    });

    it('resolves DevOps, Cloud, QA, Security, Product, and Business roles', () => {
      assert.equal(resolveResumeDomain('DevOps Engineer'), 'DEVOPS');
      assert.equal(resolveResumeDomain('Cloud Architect'), 'DEVOPS');
      assert.equal(resolveResumeDomain('Site Reliability Engineer (SRE)'), 'DEVOPS');
      assert.equal(resolveResumeDomain('QA Automation Engineer / SDET'), 'QA_TEST');
      assert.equal(resolveResumeDomain('Information Security Analyst'), 'SECURITY');
      assert.equal(resolveResumeDomain('Technical Product Manager'), 'PRODUCT_MANAGER');
      assert.equal(resolveResumeDomain('Senior Business Analyst'), 'BUSINESS_ANALYST');
      assert.equal(resolveResumeDomain('UI/UX Product Designer'), 'DESIGNER');
    });

    it('cleans unmatched custom job titles into standardized uppercase slugs', () => {
      assert.equal(resolveResumeDomain('Solutions Architect, Enterprise'), 'SOLUTIONS_ARCHITECT');
      assert.equal(resolveResumeDomain('Technical Writer - Documentation'), 'TECHNICAL_WRITER');
    });

    it('falls back to candidate profile role when job title is empty or generic', () => {
      assert.equal(resolveResumeDomain('', '', 'Full Stack Developer'), 'FULL_STACK');
      assert.equal(resolveResumeDomain(null, null, 'Data Analyst'), 'DATA_ANALYST');
      assert.equal(resolveResumeDomain(undefined, undefined, undefined), 'GENERAL');
    });
  });

  describe('sanitizeResumeClientName', () => {
    it('normalizes multi-word names with underscores and uppercase', () => {
      assert.equal(sanitizeResumeClientName('John Doe'), 'JOHN_DOE');
      assert.equal(sanitizeResumeClientName('Sai Kiran Akula'), 'SAI_KIRAN_AKULA');
      assert.equal(sanitizeResumeClientName('ARCHANA YARAMALA'), 'ARCHANA_YARAMALA');
    });

    it('strips special characters and trims excess whitespace', () => {
      assert.equal(sanitizeResumeClientName('Mary-Jane Watson-Parker'), 'MARY_JANE_WATSON_PARKER');
      assert.equal(sanitizeResumeClientName('  O\'Connor, Sean  '), 'O_CONNOR_SEAN');
    });

    it('falls back cleanly if name is empty', () => {
      assert.equal(sanitizeResumeClientName(''), 'CANDIDATE');
      assert.equal(sanitizeResumeClientName(null), 'CANDIDATE');
    });
  });

  describe('buildResumeSubmissionFilename', () => {
    it('builds canonical RESUME_CLIENTNAME_DOMAIN.pdf filename for Full Stack position', () => {
      const filename = buildResumeSubmissionFilename('John Doe', 'Full Stack Engineer');
      assert.equal(filename, 'RESUME_JOHN_DOE_FULL_STACK.pdf');
    });

    it('builds canonical filename across diverse roles and client names', () => {
      assert.equal(
        buildResumeSubmissionFilename('Sai Kiran Akula', 'Senior Data Analyst', 'Acme Corp'),
        'RESUME_SAI_KIRAN_AKULA_DATA_ANALYST.pdf'
      );
      assert.equal(
        buildResumeSubmissionFilename('Raj Kumar', 'DevOps / Cloud Specialist', 'Stripe'),
        'RESUME_RAJ_KUMAR_DEVOPS.pdf'
      );
      assert.equal(
        buildResumeSubmissionFilename('Archana Yaramala', 'Backend Java Developer'),
        'RESUME_ARCHANA_YARAMALA_BACKEND.pdf'
      );
    });

    it('handles fallback profile role when job title is missing', () => {
      assert.equal(
        buildResumeSubmissionFilename('Jane Doe', '', 'Meta', 'Product Manager'),
        'RESUME_JANE_DOE_PRODUCT_MANAGER.pdf'
      );
    });
  });

  describe('storage integration', () => {
    it('produces standard uppercase domain shortcode without GEN fallback', () => {
      assert.equal(resumeDomainShortcode({ jobTitle: 'Full Stack Engineer' }), 'FULL_STACK');
      assert.equal(resumeDomainShortcode({ jobTitle: 'Software Engineer' }), 'SOFTWARE_ENGINEER');
      assert.equal(resumeDomainShortcode({ jobTitle: 'Data Analyst' }), 'DATA_ANALYST');
    });

    it('generates standard uppercase storage filename for profiles', () => {
      const filename = resumeStorageFilename('AWL-45422', {
        firstName: 'Raj',
        lastName: 'Kumar',
        jobTitle: 'Full Stack Engineer',
      });
      assert.equal(filename, 'RESUME_RAJ_KUMAR_FULL_STACK.pdf');
    });
  });
});
