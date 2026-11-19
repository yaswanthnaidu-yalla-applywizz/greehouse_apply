import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  updateStatus,
  cacheApplicationLocally,
  getApplication,
  type ApplicationRow,
} from '../src/db/applications.js';

describe('updateStatus status downgrade guards', () => {
  beforeEach(() => {
    // Reset local memory state
    const app: ApplicationRow = {
      id: 'test-app-applied',
      applywizz_id: 'AWL-TEST-1',
      job_url: 'https://boards.greenhouse.io/test/jobs/1',
      status: 'APPLIED',
      proof_web_url: 'https://storage/proofs/test_web.png',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    cacheApplicationLocally(app);
  });

  it('refuses to downgrade APPLIED to FAILED without force=true', async () => {
    const updated = await updateStatus('test-app-applied', 'FAILED', {
      error_message: 'Worker timed out',
    });
    assert.equal(updated, false, 'Expected updateStatus to reject downgrade to FAILED');

    const app = await getApplication('test-app-applied');
    assert.equal(app?.status, 'APPLIED', 'Status should remain APPLIED');
  });

  it('refuses to downgrade EMAIL_PROOF_PENDING to FAILED without force=true', async () => {
    cacheApplicationLocally({
      id: 'test-app-pending-proof',
      applywizz_id: 'AWL-TEST-2',
      job_url: 'https://boards.greenhouse.io/test/jobs/2',
      status: 'EMAIL_PROOF_PENDING',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const updated = await updateStatus('test-app-pending-proof', 'FAILED', {
      error_message: 'Worker timed out',
    });
    assert.equal(updated, false, 'Expected updateStatus to reject downgrade from EMAIL_PROOF_PENDING');

    const app = await getApplication('test-app-pending-proof');
    assert.equal(app?.status, 'EMAIL_PROOF_PENDING');
  });

  it('permits downgrading APPLIED to FAILED when force=true', async () => {
    const updated = await updateStatus('test-app-applied', 'FAILED', {
      error_message: 'Admin manually marked failed',
      force: true,
    });
    assert.equal(updated, true, 'Expected updateStatus to permit downgrade with force=true');

    const app = await getApplication('test-app-applied');
    assert.equal(app?.status, 'FAILED');
  });

  it('permits transition from APPLYING to FAILED normally', async () => {
    cacheApplicationLocally({
      id: 'test-app-applying',
      applywizz_id: 'AWL-TEST-3',
      job_url: 'https://boards.greenhouse.io/test/jobs/3',
      status: 'APPLYING',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const updated = await updateStatus('test-app-applying', 'FAILED', {
      error_message: 'Form validation failed',
    });
    assert.equal(updated, true);

    const app = await getApplication('test-app-applying');
    assert.equal(app?.status, 'FAILED');
  });
});
