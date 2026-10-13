import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('Mobile Header 2-Tier Layout in App.tsx', () => {
  it('contains desktop-only and mobile-only 2-tier header containers', () => {
    const appTsxPath = path.resolve(process.cwd(), 'dashboard/App.tsx');
    const content = fs.readFileSync(appTsxPath, 'utf8');

    // Desktop container must hide on mobile (hidden md:flex)
    assert.match(content, /hidden\s+md:flex/);

    // Mobile container must be visible on mobile and hidden on desktop (flex\s+md:hidden\s+flex-col)
    assert.match(content, /flex\s+md:hidden\s+flex-col/);

    // Mobile tier 1 should have ApplyWizz logo/branding and notification/signout
    assert.match(content, /data-testid="mobile-header-tier-1"/);

    // Mobile tier 2 should have date picker, refresh, dev switcher
    assert.match(content, /data-testid="mobile-header-tier-2"/);
  });
});
