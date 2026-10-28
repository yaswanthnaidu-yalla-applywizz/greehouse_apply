import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

describe('Admin Search Pushdown', () => {
  test('adminDashboard.ts applies search filter before pagination range', () => {
    const code = fs.readFileSync(path.resolve('src/server/routes/adminDashboard.ts'), 'utf-8');
    const rangeIdx = code.indexOf('.range(');
    const searchIdx = code.indexOf('query.or(');
    assert.ok(searchIdx > -1, 'query.or must be used for SQL search');
    assert.ok(searchIdx < rangeIdx, 'SQL search must be applied before .range() pagination');
  });
});
