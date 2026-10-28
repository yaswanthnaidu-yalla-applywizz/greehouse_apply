import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

describe('Redundant Component Polling Purged', () => {
  test('ApplicationStatusBadge.tsx does not contain setInterval', () => {
    const code = fs.readFileSync(path.resolve('dashboard/components/ApplicationStatusBadge.tsx'), 'utf-8');
    assert.equal(code.includes('setInterval'), false, '2s poll interval must be removed');
  });

  test('SubmissionControls.tsx does not contain setInterval', () => {
    const code = fs.readFileSync(path.resolve('dashboard/components/SubmissionControls.tsx'), 'utf-8');
    assert.equal(code.includes('setInterval'), false, '3s poll interval must be removed');
  });
});
