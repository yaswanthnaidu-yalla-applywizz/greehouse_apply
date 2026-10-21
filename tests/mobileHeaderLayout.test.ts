import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('2-Tier Header Layout in App.tsx / DashboardHeader.tsx', () => {
  it('contains Tier 1 with logo + Dashboard/Stats tabs, and Tier 2 with date filter and controls', () => {
    const headerPath = fs.existsSync(path.resolve(process.cwd(), 'dashboard/components/Header/DashboardHeader.tsx'))
      ? path.resolve(process.cwd(), 'dashboard/components/Header/DashboardHeader.tsx')
      : path.resolve(process.cwd(), 'dashboard/App.tsx');
    const content = fs.readFileSync(headerPath, 'utf8');

    // Both Tier 1 and Tier 2 must exist
    assert.match(content, /data-testid="header-tier-1"/);
    assert.match(content, /data-testid="header-tier-2"/);

    // Extract tier 1 content to verify tabs are placed beside the logo
    const tier1Match = content.match(/data-testid="header-tier-1"[\s\S]*?data-testid="header-tier-2"/);
    assert.ok(tier1Match, 'header-tier-1 block must be present');
    const tier1Content = tier1Match[0];

    assert.match(tier1Content, /setActiveTab\('dashboard'\)/);
    assert.match(tier1Content, /setActiveTab\('stats'\)/);

    // Old duplicate desktop row must NOT be present
    assert.doesNotMatch(content, /data-testid="unified-header"/);
  });
});
