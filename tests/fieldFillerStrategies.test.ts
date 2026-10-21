import { describe, it, expect } from 'vitest';
import { fillFileField } from '../src/submitter/fieldFillers/fileFiller.js';
import { fillSelectField } from '../src/submitter/fieldFillers/selectFiller.js';
import { fillTextField } from '../src/submitter/fieldFillers/textFiller.js';
import { fillBooleanField } from '../src/submitter/fieldFillers/booleanFiller.js';

describe('Field Filler Strategies', () => {
  it('exports discrete filler strategy functions', () => {
    expect(typeof fillFileField).toBe('function');
    expect(typeof fillSelectField).toBe('function');
    expect(typeof fillTextField).toBe('function');
    expect(typeof fillBooleanField).toBe('function');
  });
});
