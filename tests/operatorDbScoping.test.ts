import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

describe('Database-Only Operator Scoping', () => {
  test('Migration 039 file exists with index creation', () => {
    const migPath = path.resolve('src/db/migrations/039_idx_profiles_ca_email.sql');
    assert.ok(fs.existsSync(migPath), 'Migration 039 must exist');
    const content = fs.readFileSync(migPath, 'utf-8');
    assert.ok(content.includes('idx_profiles_ca_email'), 'Index on profiles(ca_email) must be declared');
  });

  test('applications.ts does not call mergeWorkHistoryForIstDates', () => {
    const code = fs.readFileSync(path.resolve('src/server/routes/applications.ts'), 'utf-8');
    assert.equal(code.includes('mergeWorkHistoryForIstDates'), false);
  });

  test('managerTeamScope.ts does not call mergeWorkHistoryForIstDates', () => {
    const code = fs.readFileSync(path.resolve('src/server/managerTeamScope.ts'), 'utf-8');
    assert.equal(code.includes('mergeWorkHistoryForIstDates'), false);
  });

  test('auth.ts does not call fetchAllowedCandidates or setCachedWorkHistory', () => {
    const code = fs.readFileSync(path.resolve('src/server/routes/auth.ts'), 'utf-8');
    assert.equal(code.includes('fetchAllowedCandidates'), false);
    assert.equal(code.includes('setCachedWorkHistory'), false);
  });

  test('notifications.ts does not call mergeWorkHistoryForIstDates', () => {
    const code = fs.readFileSync(path.resolve('src/server/routes/notifications.ts'), 'utf-8');
    assert.equal(code.includes('mergeWorkHistoryForIstDates'), false);
  });

  test('index.ts does not call mergeWorkHistoryForIstDates', () => {
    const code = fs.readFileSync(path.resolve('src/server/index.ts'), 'utf-8');
    assert.equal(code.includes('mergeWorkHistoryForIstDates'), false);
  });

  test('candidates.ts does not call mergeWorkHistoryForIstDates', () => {
    const code = fs.readFileSync(path.resolve('src/server/routes/candidates.ts'), 'utf-8');
    assert.equal(code.includes('mergeWorkHistoryForIstDates'), false);
  });

  test('managerTeamScope.ts does not call mergeWorkHistoryForCaEmails', () => {
    const code = fs.readFileSync(path.resolve('src/server/managerTeamScope.ts'), 'utf-8');
    assert.equal(code.includes('mergeWorkHistoryForCaEmails'), false);
  });

  test('workHistorySpan and workHistoryCache files are deleted', () => {
    assert.equal(fs.existsSync(path.resolve('src/server/workHistorySpan.ts')), false);
    assert.equal(fs.existsSync(path.resolve('src/server/workHistoryCache.ts')), false);
  });
});
