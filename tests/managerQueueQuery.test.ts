import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

describe('Manager Queue Query Consolidation', () => {
  test('manager.ts does not execute 3 separate listApplications calls for queue', () => {
    const code = fs.readFileSync(path.resolve('src/server/routes/manager.ts'), 'utf-8');
    const queueSection = code.substring(code.indexOf("/queue'"), code.indexOf("/candidates'"));
    const listCount = (queueSection.match(/listApplications/g) || []).length;
    assert.equal(listCount, 0, 'listApplications should not be called in queue route');
  });
});
