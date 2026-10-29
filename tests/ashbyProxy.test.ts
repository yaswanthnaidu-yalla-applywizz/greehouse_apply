import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAshbyProxyConfig,
  parseCountryCode,
  parseCityFromLocation,
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
