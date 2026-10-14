import { describe, it, expect } from 'vitest';
import { matchChoiceOption } from '../src/utils/choiceOptions.js';

describe('Degree Level Canonical Matching', () => {
  it('matches "Master of Science in Computer Science" to "Master\'s"', () => {
    const options = ["Bachelor's", "Master's", "Doctorate", "Other"];
    expect(matchChoiceOption('Master of Science in Computer Science', options)).toBe("Master's");
  });

  it('matches "Master of Science" to "MS"', () => {
    const options = ['BS', 'BA', 'MS', 'MA', 'PhD'];
    expect(matchChoiceOption('Master of Science', options)).toBe('MS');
  });

  it('matches "Bachelor of Science" to "Bachelor\'s"', () => {
    const options = ["High School", "Bachelor's", "Master's", "Doctorate"];
    expect(matchChoiceOption('Bachelor of Science', options)).toBe("Bachelor's");
  });

  it('matches "Bachelor of Technology" to "BS"', () => {
    const options = ['BS', 'MS', 'PhD'];
    expect(matchChoiceOption('Bachelor of Technology', options)).toBe('BS');
  });
});
