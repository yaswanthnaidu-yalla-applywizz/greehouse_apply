import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLocationCityStateCountry } from '../src/submitter/formFiller.js';

test('formatLocationCityStateCountry extracts and formats City, State, Country', () => {
  const corrupted = 'Dora Babu Chintala \nfalls Church, Virginia, United States';
  assert.equal(formatLocationCityStateCountry(corrupted), 'Falls Church, Virginia, United States');

  const cityState = 'Austin, TX';
  assert.equal(formatLocationCityStateCountry(cityState), 'Austin, TX, United States');

  const alreadyClean = 'San Francisco, California, United States';
  assert.equal(formatLocationCityStateCountry(alreadyClean), 'San Francisco, California, United States');

  const singleCity = 'Dallas';
  assert.equal(formatLocationCityStateCountry(singleCity), 'Dallas');

  const usaVariant = 'Seattle, Washington, USA';
  assert.equal(formatLocationCityStateCountry(usaVariant), 'Seattle, Washington, United States');
});
