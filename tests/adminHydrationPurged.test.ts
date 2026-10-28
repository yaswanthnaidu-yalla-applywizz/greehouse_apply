import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

describe('Admin Profile Hydration Purged', () => {
  test('adminProfileHydrate.ts does not exist', () => {
    const filePath = path.resolve('src/services/adminProfileHydrate.ts');
    assert.equal(fs.existsSync(filePath), false, 'File must be deleted');
  });

  test('App.tsx does not contain ensureAdminHydrated', () => {
    const appTsx = fs.readFileSync(path.resolve('dashboard/App.tsx'), 'utf-8');
    assert.equal(appTsx.includes('ensureAdminHydrated'), false, 'ensureAdminHydrated must be removed');
    assert.equal(appTsx.includes('isAuthHydrating'), false, 'isAuthHydrating must be removed');
  });
});
