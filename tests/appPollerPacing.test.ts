import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

describe('App.tsx Poller Pacing & Socket Stability', () => {
  test('App.tsx paces disconnected poll to 15s and gates on visibility', () => {
    const code = fs.readFileSync(path.resolve('dashboard/App.tsx'), 'utf-8');
    assert.ok(code.includes('15000'), 'Disconnected fallback must be 15000ms');
    assert.ok(code.includes('visibilityState'), 'Poller must check document.visibilityState');
  });

  test('WebSocket useEffect does not depend on selectedCandidateId or selectedJobUrl', () => {
    const code = fs.readFileSync(path.resolve('dashboard/App.tsx'), 'utf-8');
    const wsHookMatch = code.match(/connectWs\(\);[\s\S]*?\}, \[(.*?)\]\);/);
    assert.ok(wsHookMatch, 'WebSocket useEffect hook must be found');
    const deps = wsHookMatch[1];
    assert.equal(deps.includes('selectedCandidateId'), false, 'Must not depend on selectedCandidateId');
    assert.equal(deps.includes('selectedJobUrl'), false, 'Must not depend on selectedJobUrl');
  });
});
