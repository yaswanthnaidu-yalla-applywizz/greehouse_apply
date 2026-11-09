import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('Dashboard Header Operator Date Picker', () => {
  it('allows the operator to select a date and displays the application date', () => {
    const headerPath = path.resolve(process.cwd(), 'dashboard/components/Header/DashboardHeader.tsx');
    const content = fs.readFileSync(headerPath, 'utf8');

    // header-tier-1 and header-tier-2 must remain
    assert.match(content, /data-testid="header-tier-1"/);
    assert.match(content, /data-testid="header-tier-2"/);

    assert.match(content, /data-testid="application-date-picker"/);
    assert.match(content, /setSelectedDate\(event\.currentTarget\.value\)/);

    // Date scope badge and picker must be present
    assert.match(content, /data-testid="latest-batch-badge"/);
    assert.match(content, /Application Date/);
  });

  it('App.tsx honors the selected date in candidate detail requests', () => {
    const appPath = path.resolve(process.cwd(), 'dashboard/App.tsx');
    const content = fs.readFileSync(appPath, 'utf8');

    // Verifies x-dashboard-latest-date is inspected and updates selectedDate
    assert.match(content, /x-dashboard-latest-date/i);
    assert.match(content, /dateQuery = selectedDate \?/);
    assert.match(content, /jobs\/\$\{encodedUrl\}\$\{dateQuery\}/);
  });
});
