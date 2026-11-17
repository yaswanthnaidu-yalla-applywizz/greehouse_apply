import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildResumeSubmissionFilename } from '../src/utils/resumeNaming.js';

describe('formFiller & ashbySubmit resume naming integration', () => {
  it('generates Resume_FirstName_LastName_JobRole.pdf from candidate profile and application job title', () => {
    const profile = {
      applywizz_id: 'AWL-45422',
      client_name: 'Raj Kumar',
      first_name: 'Raj',
      last_name: 'Kumar',
      work_experience: [{ title: 'Software Engineer' }],
    };

    const filename = buildResumeSubmissionFilename(
      profile,
      'Senior Full-Stack Developer - Stripe - Greenhouse',
      'Stripe'
    );

    assert.equal(filename, 'Resume_Raj_Kumar_Senior_Full_Stack_Developer.pdf');
  });

  it('handles titles with at delimiter and ATS suffixes', () => {
    const profile = {
      first_name: 'Alice',
      last_name: 'Smith',
    };

    const filename = buildResumeSubmissionFilename(
      profile,
      'Product Manager at Google | Greenhouse',
      'Google'
    );

    assert.equal(filename, 'Resume_Alice_Smith_Product_Manager.pdf');
  });

  it('falls back to candidate profile role if job title is empty', () => {
    const profile = {
      first_name: 'Bob',
      last_name: 'Builder',
      work_experience: [{ title: 'DevOps Specialist' }],
    };

    const filename = buildResumeSubmissionFilename(profile, '', 'Acme Corp');
    assert.equal(filename, 'Resume_Bob_Builder_DevOps_Specialist.pdf');
  });
});
