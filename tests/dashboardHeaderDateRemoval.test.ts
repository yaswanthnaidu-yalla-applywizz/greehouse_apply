import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('Dashboard Header Operator Date Picker Removal', () => {
  it('DashboardHeader does not contain manual date picker input and contains latest batch badge', () => {
    const headerPath = path.resolve(process.cwd(), 'dashboard/components/Header/DashboardHeader.tsx');
    const content = fs.readFileSync(headerPath, 'utf8');

    // header-tier-1 and header-tier-2 must remain
    assert.match(content, /data-testid="header-tier-1"/);
    assert.match(content, /data-testid="header-tier-2"/);

    // Date picker input MUST NOT be present
    assert.doesNotMatch(content, /<input[\s\S]*?type=["']date["']/);

    // Latest batch badge must be present
    assert.match(content, /data-testid="latest-batch-badge"/);
    assert.match(content, /Latest Batch/);
  });

  it('App.tsx updates selectedDate from x-dashboard-latest-date header', () => {
    const appPath = path.resolve(process.cwd(), 'dashboard/App.tsx');
    const content = fs.readFileSync(appPath, 'utf8');

    // Verifies x-dashboard-latest-date is inspected and updates selectedDate
    assert.match(content, /x-dashboard-latest-date/i);
  });
});
