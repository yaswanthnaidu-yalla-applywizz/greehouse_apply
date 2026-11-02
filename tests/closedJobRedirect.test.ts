import test from 'node:test';
import assert from 'node:assert/strict';
import { isGreenhouseJobClosedUrl } from '../src/submitter/liveSubmit.js';

test('isGreenhouseJobClosedUrl detects job closed error redirect', () => {
  assert.equal(
    isGreenhouseJobClosedUrl(
      'https://job-boards.greenhouse.io/uberfreight?error=true',
      'https://job-boards.greenhouse.io/uberfreight/jobs/5467567008'
    ),
    true
  );
  assert.equal(
    isGreenhouseJobClosedUrl(
      'https://boards.greenhouse.io/uberfreight?error=true',
      'https://boards.greenhouse.io/uberfreight/jobs/5467567008'
    ),
    true
  );
  assert.equal(
    isGreenhouseJobClosedUrl(
      'https://job-boards.greenhouse.io/uberfreight/jobs/5467567008',
      'https://job-boards.greenhouse.io/uberfreight/jobs/5467567008'
    ),
    false
  );
  assert.equal(
    isGreenhouseJobClosedUrl(
      'https://boards.greenhouse.io/uberfreight/jobs/5467567008?gh_jid=5467567008',
      'https://boards.greenhouse.io/uberfreight/jobs/5467567008'
    ),
    false
  );
  assert.equal(
    isGreenhouseJobClosedUrl(
      'https://job-boards.greenhouse.io/uberfreight',
      'https://job-boards.greenhouse.io/uberfreight/jobs/5467567008'
    ),
    true
  );
});
