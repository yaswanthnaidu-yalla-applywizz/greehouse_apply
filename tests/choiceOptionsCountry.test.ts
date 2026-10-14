import { describe, it, expect } from 'vitest';
import { matchChoiceOption } from '../src/utils/choiceOptions.js';

describe('Country Choice Options Matching with Dial Codes', () => {
  it('matches "United States" to "United States +1"', () => {
    const options = [
      'United States +1',
      'Afghanistan +93',
      'Albania +355',
      'Canada +1',
      'India +91',
    ];
    expect(matchChoiceOption('United States', options)).toBe('United States +1');
  });

  it('matches country alias "USA" to "United States +1"', () => {
    const options = [
      'United States +1',
      'Afghanistan +93',
      'Canada +1',
    ];
    expect(matchChoiceOption('USA', options)).toBe('United States +1');
  });

  it('matches "India" to "India +91"', () => {
    const options = [
      'United States +1',
      'India +91',
      'Indonesia +62',
    ];
    expect(matchChoiceOption('India', options)).toBe('India +91');
  });
});
