import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  normalizeOptionText,
  matchDropdownOption,
  formatInvalidFieldLog,
} from '../src/submitter/formFiller.js';

describe('Phase 3: Form Filler Unicode Normalization & Multi-Stage Dropdown Matching', () => {
  test('normalizeOptionText converts U+2019 curly apostrophe to straight', () => {
    const curly = 'Master\u2019s Degree';
    const normalized = normalizeOptionText(curly);
    assert.strictEqual(normalized, "master's degree");
  });

  test('normalizeOptionText converts en-dash to hyphen', () => {
    const enDash = 'Full\u2013time';
    const normalized = normalizeOptionText(enDash);
    assert.strictEqual(normalized, 'full-time');

    const emDash = 'Part\u2014time';
    assert.strictEqual(normalizeOptionText(emDash), 'part-time');
  });

  test('normalizeOptionText collapses multiple spaces', () => {
    const spaces = '   Bachelor\u2019s     Degree   in   CS   ';
    const normalized = normalizeOptionText(spaces);
    assert.strictEqual(normalized, "bachelor's degree in cs");
  });

  test('Stage 1 matches "Master\'s Degree" (curly) to "Master\'s Degree" (straight)', () => {
    const options = ['High School', "Master's Degree", "Bachelor's Degree"];
    const target = 'Master\u2019s Degree';
    const res = matchDropdownOption(options, target);
    assert.strictEqual(res.stage, 1);
    assert.strictEqual(res.matchedOption, "Master's Degree");
  });

  test('Stage 1 does NOT match partial prefix (defers to Stage 2)', () => {
    const options = ["Master's Degree in Computer Science"];
    const target = "Master's";
    // Exact normalized should miss, falling into Stage 2
    const res = matchDropdownOption(options, target);
    assert.strictEqual(res.stage, 2);
    assert.strictEqual(res.matchedOption, "Master's Degree in Computer Science");
  });

  test('Stage 2 matches "Master\'s" to "Master\'s Degree in Computer Science"', () => {
    const options = ['High School', "Master's Degree in Computer Science", 'Other'];
    const target = "Master's";
    const res = matchDropdownOption(options, target);
    assert.strictEqual(res.stage, 2);
    assert.strictEqual(res.matchedOption, "Master's Degree in Computer Science");
  });

  test('Stage 2 does NOT fuzzy-match unrelated strings (defers to Stage 3)', () => {
    const options = ["Bachelor's Degree"];
    const target = 'Bachelors';
    // "Bachelors" does NOT startWith or equal "bachelor's degree" (missing apostrophe), so Stage 1 & 2 miss
    // Defers to Stage 3 Fuse token-set search
    const res = matchDropdownOption(options, target);
    assert.strictEqual(res.stage, 3);
    assert.strictEqual(res.matchedOption, "Bachelor's Degree");
  });

  test('Stage 3 matches "Bachelors" to "Bachelor\'s Degree" via Fuse', () => {
    const options = ['Associate Degree', "Bachelor's Degree", 'Doctorate'];
    const target = 'Bachelors';
    const res = matchDropdownOption(options, target);
    assert.strictEqual(res.stage, 3);
    assert.strictEqual(res.matchedOption, "Bachelor's Degree");
  });

  test('all-stage miss returns null (not first option)', () => {
    const options = ['Associate Degree', "Bachelor's Degree", 'High School'];
    const target = 'Doctorate of Philosophy';
    const res = matchDropdownOption(options, target);
    assert.strictEqual(res.stage, null);
    assert.strictEqual(res.matchedOption, null);
  });

  test('invalid-field log includes label text from DOM', () => {
    const label = 'Highest Level of Education';
    const filled = 'Select...';
    const options = ['High School', "Bachelor's Degree"];
    const logOutput = formatInvalidFieldLog(label, filled, options);

    assert.ok(logOutput.includes('[FormFiller] ❌ required field invalid:'));
    assert.ok(logOutput.includes(`label="${label}"`));
    assert.ok(logOutput.includes(`filled="${filled}"`));
    assert.ok(logOutput.includes("Bachelor's Degree"));
  });
});
