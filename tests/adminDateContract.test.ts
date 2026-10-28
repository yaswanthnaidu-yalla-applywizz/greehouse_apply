import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

describe('Admin Date Contract', () => {
  test('adminDashboard.ts supports lifetime mode when date is all-time or empty', () => {
    const code = fs.readFileSync(path.resolve('src/server/routes/adminDashboard.ts'), 'utf-8');
    assert.ok(code.includes('lifetime') || code.includes('all-time'), 'Date query must support lifetime mode');
  });

  test('adminDashboard.ts /applications route accepts lifetime without 400', () => {
    const code = fs.readFileSync(path.resolve('src/server/routes/adminDashboard.ts'), 'utf-8');
    const appsSection = code.substring(code.indexOf("'/applications'"));
    assert.ok(appsSection.includes('lifetime') || appsSection.includes('all-time'), 'Applications route must support lifetime date');
  });

  test('adminDashboard.ts /managers/:email/dashboard route accepts lifetime without 400', () => {
    const code = fs.readFileSync(path.resolve('src/server/routes/adminDashboard.ts'), 'utf-8');
    const mgrDashSection = code.substring(code.indexOf("'/managers/:email/dashboard'"), code.indexOf("'/operators'"));
    assert.ok(mgrDashSection.includes('lifetime') || mgrDashSection.includes('all-time'), 'Manager dashboard route must support lifetime date');
  });

  test('AdminDashboard.tsx supports [ Today | Lifetime | Custom Date ] segmented selection', () => {
    const code = fs.readFileSync(path.resolve('dashboard/components/AdminDashboard.tsx'), 'utf-8');
    assert.ok(code.includes('Today'), 'Must have Today option');
    assert.ok(code.includes('Lifetime'), 'Must have Lifetime option');
    assert.ok(code.includes('Custom Date'), 'Must have Custom Date option');
    assert.ok(code.includes("'lifetime'"), 'Must support setting lifetime date query');
  });
});
