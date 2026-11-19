import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAshbyProxyConfig,
  extractCountryFromLocation,
  US_STATE_CODES,
  verifyProxyPreflight,
} from '../src/submitter/ashbyProxy.js';

process.env.NODE_ENV = 'test';

describe('Ashby Proxy Configuration (US State Disambiguation & Probe Endpoint)', () => {
  it('resolves proxy region "us" for US states and never "ga" (Gabon)', () => {
    assert.equal(
      extractCountryFromLocation('Atlanta, GA'),
      'us',
      'Atlanta, GA must resolve to US proxy region, never Gabon (ga)'
    );
  });

  it('resolves proxy region "us" for various US state formats', () => {
    assert.equal(extractCountryFromLocation('Austin, TX'), 'us');
    assert.equal(extractCountryFromLocation('New York, NY'), 'us');
    assert.equal(extractCountryFromLocation('San Francisco, CA'), 'us');
    assert.equal(extractCountryFromLocation('Seattle, WA'), 'us');
    assert.equal(extractCountryFromLocation('Chicago, IL'), 'us');
  });

  it('preserves non-US countries accurately', () => {
    assert.equal(extractCountryFromLocation('Dublin, Leinster, Ireland'), 'ie');
    assert.equal(extractCountryFromLocation('London, England'), 'gb');
    assert.equal(extractCountryFromLocation('Toronto, ON, Canada'), 'ca');
    assert.equal(extractCountryFromLocation('Berlin, Germany'), 'de');
    assert.equal(extractCountryFromLocation('Bengaluru, India'), 'in');
  });

  it('verifies US_STATE_CODES contains 50 US states plus DC and PR', () => {
    assert.ok(US_STATE_CODES.has('ga'));
    assert.ok(US_STATE_CODES.has('tx'));
    assert.ok(US_STATE_CODES.has('ny'));
    assert.ok(US_STATE_CODES.has('ca'));
    assert.ok(US_STATE_CODES.has('dc'));
    assert.ok(US_STATE_CODES.has('pr'));
    assert.ok(US_STATE_CODES.size >= 52);
  });

  it('defaults verifyProxyPreflight primary probe URL to api64.ipify.org', async () => {
    let requestedUrl = '';
    const mockPage: any = {
      request: {
        get: async (url: string) => {
          requestedUrl = url;
          return {
            status: () => 200,
            ok: () => true,
            json: async () => ({ ip: '1.2.3.4' }),
          };
        },
      },
    };

    const result = await verifyProxyPreflight(mockPage, undefined, { timeoutMs: 1000 });
    assert.ok(result.success, 'Preflight should succeed with valid IP');
    assert.ok(
      requestedUrl.includes('api64.ipify.org'),
      `Probe URL must target api64.ipify.org, got: ${requestedUrl}`
    );
  });

  it('builds an Apify residential proxy from APIFY_STRING with a random non-identifying session', () => {
    const profile = {
      applywizz_id: 'AWL-12345',
      country: 'United States',
      location: 'Austin, TX',
    } as any;
    const options = { provider: 'apify', apifyString: 'http://apify-user:apify-secret@proxy.example:8123' } as any;
    const first = buildAshbyProxyConfig(profile, options);
    const second = buildAshbyProxyConfig(profile, options);

    assert.equal(first.server, 'http://proxy.example:8123');
    assert.equal(first.username.split(',')[0], 'groups-RESIDENTIAL');
    assert.equal(first.password, 'apify-secret');
    assert.match(first.username, /^groups-RESIDENTIAL,country-US,session-[a-zA-Z0-9._~]{1,50}$/);
    assert.doesNotMatch(first.username, /AWL|12345/i);
    assert.notEqual(first.username, second.username);
  });

  it('rejects malformed Apify proxy URLs without exposing credentials', () => {
    const profile = { country: 'Canada' } as any;
    for (const apifyString of [
      'not-a-url',
      'https://apify-user:apify-secret@proxy.example:8123',
      'http://apify-user@proxy.example:8123',
      'http://:apify-secret@proxy.example:8123',
      'http://apify-user:apify-secret@proxy.example',
      'http://apify-user:apify-secret@proxy.example:0',
    ]) {
      assert.throws(
        () => buildAshbyProxyConfig(profile, { provider: 'apify', apifyString } as any),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.doesNotMatch(error.message, /apify-user|apify-secret/);
          return /APIFY_STRING/.test(error.message);
        }
      );
    }
  });

  it('accepts APIFY_STRING as an optional environment setting', async () => {
    const previousString = process.env.APIFY_STRING;
    process.env.APIFY_STRING = 'http://user:password@proxy.example:8123';
    try {
      const { config } = await import('../src/config/env.js');
      assert.equal(config.APIFY_STRING, 'http://user:password@proxy.example:8123');
    } finally {
      if (previousString === undefined) delete process.env.APIFY_STRING;
      else process.env.APIFY_STRING = previousString;
    }
  });

  it('preserves DataImpulse as the default when Apify credentials are also configured', () => {
    const credentialNames = [
      'APIFY_STRING',
      'MASSIVE_USERNAME',
      'MASSIVE_PASSWORD',
      'DATAIMPULSE_LOGIN',
      'DATAIMPULSE_PASSWORD',
    ];
    const previousValues = new Map(credentialNames.map((name) => [name, process.env[name]]));
    delete process.env.MASSIVE_USERNAME;
    delete process.env.MASSIVE_PASSWORD;
    process.env.APIFY_STRING = 'http://apify-user:apify-secret@proxy.example:8123';
    process.env.DATAIMPULSE_LOGIN = 'dataimpulse-user';
    process.env.DATAIMPULSE_PASSWORD = 'dataimpulse-password';
    try {
      const config = buildAshbyProxyConfig({ country: 'Canada' } as any);
      assert.equal(config.server, 'http://gw.dataimpulse.com:823');
      assert.equal(config.password, 'dataimpulse-password');
    } finally {
      for (const [name, value] of previousValues) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
