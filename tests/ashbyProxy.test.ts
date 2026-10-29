import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAshbyProxyConfig,
  parseCountryCode,
  parseCityFromLocation,
  resolveCountryCode,
  InvalidCountryError,
} from '../src/submitter/ashbyProxy.js';

test('parses US country code', () => {
  assert.equal(parseCountryCode('United States'), 'us');
  assert.equal(parseCountryCode('USA'), 'us');
  assert.equal(parseCountryCode('US'), 'us');
});

test('parses Canada and UK country codes', () => {
  assert.equal(parseCountryCode('Canada'), 'ca');
  assert.equal(parseCountryCode('United Kingdom'), 'gb');
  assert.equal(parseCountryCode('UK'), 'gb');
  assert.equal(parseCountryCode('Great Britain'), 'gb');
  assert.equal(parseCountryCode('England'), 'gb');
  assert.equal(parseCountryCode('Scotland'), 'gb');
  assert.equal(parseCountryCode('Wales'), 'gb');
});

test('parses Ireland and Netherlands country codes', () => {
  assert.equal(parseCountryCode('Ireland'), 'ie');
  assert.equal(parseCountryCode('Republic of Ireland'), 'ie');
  assert.equal(parseCountryCode('IE'), 'ie');
  assert.equal(parseCountryCode('Netherlands'), 'nl');
  assert.equal(parseCountryCode('Holland'), 'nl');
  assert.equal(parseCountryCode('NL'), 'nl');
});

test('parses other major tech hiring geographies', () => {
  assert.equal(parseCountryCode('Germany'), 'de');
  assert.equal(parseCountryCode('Deutschland'), 'de');
  assert.equal(parseCountryCode('France'), 'fr');
  assert.equal(parseCountryCode('India'), 'in');
  assert.equal(parseCountryCode('Australia'), 'au');
  assert.equal(parseCountryCode('Singapore'), 'sg');
  assert.equal(parseCountryCode('Switzerland'), 'ch');
  assert.equal(parseCountryCode('Sweden'), 'se');
  assert.equal(parseCountryCode('Spain'), 'es');
  assert.equal(parseCountryCode('Poland'), 'pl');
});

test('accepts direct 2-letter ISO codes', () => {
  assert.equal(parseCountryCode('br'), 'br');
  assert.equal(parseCountryCode('JP'), 'jp');
  assert.equal(parseCountryCode('it'), 'it');
  assert.equal(parseCountryCode('NO'), 'no');
});

test('throws InvalidCountryError on invalid or missing country in parseCountryCode', () => {
  assert.throws(() => parseCountryCode(null), InvalidCountryError);
  assert.throws(() => parseCountryCode(undefined), InvalidCountryError);
  assert.throws(() => parseCountryCode(''), InvalidCountryError);
  assert.throws(() => parseCountryCode('Atlantis'), InvalidCountryError);
  assert.throws(() => parseCountryCode('XYZ123'), InvalidCountryError);
});

test('resolveCountryCode multi-tier resolution', () => {
  // Tier 1: profile.country
  assert.equal(
    resolveCountryCode({ country: 'Ireland', location: 'Dublin' } as any),
    'ie'
  );

  // Tier 2: location fallback
  assert.equal(
    resolveCountryCode({ country: null, location: 'Dublin, Leinster, Ireland' } as any),
    'ie'
  );
  assert.equal(
    resolveCountryCode({ country: '', location: 'Amsterdam, North Holland, Netherlands' } as any),
    'nl'
  );

  // Tier 3: phone calling code prefix fallback
  assert.equal(
    resolveCountryCode({ country: null, location: 'Unknown', country_code: '+353' } as any),
    'ie'
  );
  assert.equal(
    resolveCountryCode({ country: null, location: null, country_code: '+1' } as any),
    'us'
  );
  assert.equal(
    resolveCountryCode({ country: null, location: '', country_code: '+44' } as any),
    'gb'
  );
  assert.equal(
    resolveCountryCode({ country: null, location: null, country_code: '+91' } as any),
    'in'
  );

  // Failure: throws InvalidCountryError
  assert.throws(
    () => resolveCountryCode({ country: null, location: null, country_code: null } as any),
    InvalidCountryError
  );
  assert.throws(
    () => resolveCountryCode({ country: 'Narnia', location: 'Lantern Waste', country_code: '+9999' } as any),
    InvalidCountryError
  );
});

test('parses city from location string', () => {
  assert.equal(parseCityFromLocation('San Francisco, CA, United States'), 'SanFrancisco');
  assert.equal(parseCityFromLocation('New York, NY'), 'NewYork');
  assert.equal(parseCityFromLocation('Austin'), 'Austin');
});

test('throws when DATAIMPULSE_LOGIN is absent', () => {
  assert.throws(
    () =>
      buildAshbyProxyConfig(
        { applywizz_id: 'AWL-001', country: 'United States', location: 'Austin, TX' } as any,
        { login: '', password: 'pw', host: 'gw.dataimpulse.com', port: 823 }
      ),
    /DATAIMPULSE_LOGIN or DATAIMPULSE_PASSWORD is missing/i
  );
});

test('throws when DATAIMPULSE_PASSWORD is absent', () => {
  assert.throws(
    () =>
      buildAshbyProxyConfig(
        { applywizz_id: 'AWL-001', country: 'United States', location: 'Austin, TX' } as any,
        { login: 'user', password: '', host: 'gw.dataimpulse.com', port: 823 }
      ),
    /DATAIMPULSE_LOGIN or DATAIMPULSE_PASSWORD is missing/i
  );
});

test('builds valid geo-targeted proxy config', () => {
  const cfg = buildAshbyProxyConfig(
    { applywizz_id: 'AWL-32959', country: 'United States', location: 'New York, NY' } as any,
    { login: 'myuser', password: 'mypassword', host: 'gw.dataimpulse.com', port: 823 }
  );

  assert.equal(cfg.server, 'http://gw.dataimpulse.com:823');
  assert.equal(cfg.password, 'mypassword');
  assert.ok(cfg.username.startsWith('myuser__cr.us'));
  assert.ok(cfg.username.includes('city.NewYork'));
  assert.ok(cfg.username.includes('sessid.AWL32959_'));
  assert.ok(!cfg.username.includes(';sid.'));
});

test('uses sessid instead of sid for sticky proxy sessions', () => {
  const cfg = buildAshbyProxyConfig(
    { applywizz_id: 'AWL-32959', country: 'United States', location: 'New York, NY' } as any,
    { login: 'myuser', password: 'mypassword', attemptToken: 'test1234' }
  );
  assert.ok(cfg.username.includes('sessid.AWL32959_test1234'));
  assert.ok(!cfg.username.includes(';sid.'));

  // Without explicit attemptToken, generates 8-char hex token
  const cfgAuto = buildAshbyProxyConfig(
    { applywizz_id: 'AWL-32959', country: 'United States', location: 'New York, NY' } as any,
    { login: 'myuser', password: 'mypassword' }
  );
  assert.match(cfgAuto.username, /sessid\.AWL32959_[a-f0-9]{8}/);
  assert.ok(!cfgAuto.username.includes(';sid.'));
});

test('buildAshbyProxyConfig handles Ireland and location/phone fallbacks', () => {
  // Ireland country
  const cfgIreland = buildAshbyProxyConfig(
    { applywizz_id: 'AWL-IE', country: 'Ireland', location: 'Dublin' } as any,
    { login: 'u', password: 'p' }
  );
  assert.ok(cfgIreland.username.includes('__cr.ie'));
  assert.ok(cfgIreland.username.includes('city.Dublin'));

  // Netherlands location fallback
  const cfgNL = buildAshbyProxyConfig(
    { applywizz_id: 'AWL-NL', location: 'Amsterdam, Netherlands' } as any,
    { login: 'u', password: 'p' }
  );
  assert.ok(cfgNL.username.includes('__cr.nl'));

  // Phone code fallback
  const cfgPhone = buildAshbyProxyConfig(
    { applywizz_id: 'AWL-IN', country_code: '+91' } as any,
    { login: 'u', password: 'p' }
  );
  assert.ok(cfgPhone.username.includes('__cr.in'));
});

test('buildAshbyProxyConfig throws InvalidCountryError when country cannot be resolved', () => {
  assert.throws(
    () =>
      buildAshbyProxyConfig(
        { applywizz_id: 'AWL-UNKNOWN', country: null, location: null } as any,
        { login: 'u', password: 'p' }
      ),
    InvalidCountryError
  );
});
