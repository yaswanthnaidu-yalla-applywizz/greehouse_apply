import { describe, it, expect } from 'vitest';
import { isZeroJobsExpiredPage } from '../src/scanner/playwrightScanner.js';

describe('isZeroJobsExpiredPage', () => {
  it('detects 0 jobs listing page when application form is absent', () => {
    const pageText = 'Torc Robotics Careers. 0 jobs found. There are no jobs that match your criteria.';
    expect(isZeroJobsExpiredPage(pageText, false)).toBe(true);
  });

  it('does NOT mark expired if an application form is present', () => {
    const pageText = 'Torc Robotics. 0 jobs open in this department, but please submit an application below.';
    expect(isZeroJobsExpiredPage(pageText, true)).toBe(false);
  });

  it('does NOT mark ordinary job page as expired', () => {
    const pageText = 'Software Engineer job description and requirements.';
    expect(isZeroJobsExpiredPage(pageText, false)).toBe(false);
  });
});
