import { describe, it, expect } from 'vitest';
import { isDemoResumeApplywizzId } from '../src/db/storage.js';

describe('Demo Fixture Isolation', () => {
  it('isDemoResumeApplywizzId returns true strictly for pinned demo candidates', () => {
    expect(isDemoResumeApplywizzId('AWL-YASWANTH')).toBe(true);
    expect(isDemoResumeApplywizzId('AWL-31428')).toBe(true);
    expect(isDemoResumeApplywizzId('AWL-REAL-12345')).toBe(false);
  });
});
