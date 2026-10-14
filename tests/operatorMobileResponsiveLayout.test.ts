import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('Operator Dashboard Mobile Layout & Drawer Regression Test', () => {
  it('constrains header logo with explicit dimension limits and width/height', () => {
    const appTsxPath = path.resolve(process.cwd(), 'dashboard/App.tsx');
    const content = fs.readFileSync(appTsxPath, 'utf8');

    // Extract header tier 1 block
    const headerMatch = content.match(/data-testid="header-tier-1"[\s\S]*?<\/div>\s*<\/div>/);
    assert.ok(headerMatch, 'header-tier-1 must exist');
    const headerContent = headerMatch[0];

    // Must have max-w, max-h or inline styles to prevent uncompiled CSS blowup
    assert.match(
      headerContent,
      /<img[^>]+(max-w-\[32px\]|max-w-\[28px\]|style=\{\{\s*width:\s*['"](28px|32px)['"])/,
      'Header logo must have explicit maximum dimension constraints or inline styles'
    );
  });

  it('uses div container instead of semantic aside in ClientInfoDrawer to prevent tokens.css mobile sidebar collisions', () => {
    const drawerPath = path.resolve(process.cwd(), 'dashboard/components/ClientInfoDrawer.tsx');
    const content = fs.readFileSync(drawerPath, 'utf8');

    // Should NOT have <aside as the drawer root (which collides with .mobile-operator-workspace > aside)
    assert.doesNotMatch(
      content,
      /<aside[\s\S]*?aria-label="Client Information"/,
      'ClientInfoDrawer must not use <aside> which collides with mobile workspace aside rules'
    );

    // Should use div or dialog with role="dialog"
    assert.match(
      content,
      /<div[\s\S]*?role="dialog"/,
      'ClientInfoDrawer should use <div role="dialog">'
    );
  });

  it('unmounts drawer DOM or keeps it hidden when isOpen is false', () => {
    const drawerPath = path.resolve(process.cwd(), 'dashboard/components/ClientInfoDrawer.tsx');
    const content = fs.readFileSync(drawerPath, 'utf8');

    // Must guard rendering so inactive drawer is not rendered or invisible
    assert.match(
      content,
      /if\s*\(!candidate\s*\|\|\s*!isOpen\)\s*return null;/,
      'ClientInfoDrawer should return null when not open to prevent DOM tree overflow'
    );
  });
});
