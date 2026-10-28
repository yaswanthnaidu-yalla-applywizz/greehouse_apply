import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

describe('Adaptive Ingest Poller', () => {
  test('AdminDashboard.tsx only polls ingest status when running is true', () => {
    const code = fs.readFileSync(path.resolve('dashboard/components/AdminDashboard.tsx'), 'utf-8');
    assert.ok(code.includes('ingestRun?.running'), 'Polling must check if ingest is running');

    const pollerHookMatch = code.match(/const pollIngest = async[\s\S]*?\}, \[(.*?)\]\);/);
    assert.ok(pollerHookMatch, 'Ingest status polling effect hook must be found');
    const pollerHookBody = pollerHookMatch[0];
    assert.ok(pollerHookBody.includes('ingestRun?.running'), 'Ingest poller hook must reference ingestRun?.running');
    const deps = pollerHookMatch[1];
    assert.ok(deps.includes('ingestRun?.running'), 'Hook dependency array must include ingestRun?.running');
  });
});
