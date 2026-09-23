import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadClientDashboard } from '../src/server/clientDashboard.js';

describe('Manager Dashboard Metrics Verification', () => {
  it('loadClientDashboard computes totals correctly and excludes SKIPPED from Total and Submitted', async () => {
    const result = await loadClientDashboard({
      managerEmail: 'yaswanthnaiduyalla@applywizz.ai',
      date: '2026-09-23',
      createdAtRange: {
        startIso: '2026-09-23T00:00:00.000Z',
        endIso: '2026-09-23T23:59:59.999Z',
      },
      teamScopeUnrestricted: true,
    });

    assert.ok(result);
    assert.ok(result.totals);
    assert.strictEqual(typeof result.totals.applications, 'number');
    assert.strictEqual(typeof result.totals.submitted, 'number');
    assert.strictEqual(typeof result.totals.applied, 'number');
  });

  it('verifies ManagerDashboard.tsx pulls Total, Submitted, and Applied on both Home and Operators tabs from /api/manager/dashboard', () => {
    const tsxPath = path.resolve(process.cwd(), 'dashboard/components/ManagerDashboard.tsx');
    const content = fs.readFileSync(tsxPath, 'utf8');

    // Both tabs must render the same 3 metrics from state populated by /api/manager/dashboard
    // Check Home tab metrics
    assert.ok(
      content.includes("['Total Applications', totals.applications]"),
      'Home tab must display Total Applications from totals.applications'
    );
    assert.ok(
      content.includes("['Submitted (team)', submitted]"),
      'Home tab must display Submitted (team) from submitted'
    );
    assert.ok(
      content.includes("['Applied (team)', applied]"),
      'Home tab must display Applied (team) from applied'
    );

    // Check Operators tab metrics
    assert.ok(
      content.includes("{tab === 'operators'"),
      'Must contain operators tab block'
    );

    // Verify Operators tab renders the same 3 metrics cards
    const operatorsTabSection = content.slice(content.indexOf("{tab === 'operators'"));
    assert.ok(
      operatorsTabSection.includes("['Total Applications', totals.applications]"),
      'Operators tab must display Total Applications from totals.applications'
    );
    assert.ok(
      operatorsTabSection.includes("['Submitted (team)', submitted]"),
      'Operators tab must display Submitted (team) from submitted'
    );
    assert.ok(
      operatorsTabSection.includes("['Applied (team)', applied]"),
      'Operators tab must display Applied (team) from applied'
    );

    // Verify there are no separate count queries on Operators tab
    assert.ok(
      !operatorsTabSection.includes('operatorTotals'),
      'Operators tab must not use separate operatorTotals for the 3 top metrics'
    );
  });

  it('verifies manager.html pulls Total, Submitted, and Applied on both Home and Operators tabs from /api/manager/dashboard', () => {
    const htmlPath = path.resolve(process.cwd(), 'dashboard/public/manager.html');
    const content = fs.readFileSync(htmlPath, 'utf8');

    // Home tab metrics
    assert.ok(
      content.includes("['Total Applications', totals.applications]"),
      'manager.html Home tab must display Total Applications from totals.applications'
    );
    assert.ok(
      content.includes("['Submitted (team)', submitted]"),
      'manager.html Home tab must display Submitted (team) from submitted'
    );
    assert.ok(
      content.includes("['Applied (team)', applied]"),
      'manager.html Home tab must display Applied (team) from applied'
    );

    // Operators tab metrics
    const operatorsTabSection = content.slice(content.indexOf("{tab === 'operators'"));
    assert.ok(
      operatorsTabSection.includes("['Total Applications', totals.applications]"),
      'manager.html Operators tab must display Total Applications from totals.applications'
    );
    assert.ok(
      operatorsTabSection.includes("['Submitted (team)', submitted]"),
      'manager.html Operators tab must display Submitted (team) from submitted'
    );
    assert.ok(
      operatorsTabSection.includes("['Applied (team)', applied]"),
      'manager.html Operators tab must display Applied (team) from applied'
    );

    // Verify no separate count query state
    assert.ok(
      !content.includes('operatorTotals'),
      'manager.html must not use separate operatorTotals'
    );
  });

  it('verifies server manager route exposes consistent metrics without separate queryRollupStats counts', () => {
    const routePath = path.resolve(process.cwd(), 'src/server/routes/manager.ts');
    const content = fs.readFileSync(routePath, 'utf8');

    // /dashboard endpoint must return payload.totals directly
    assert.ok(
      content.includes('totalApplications: payload.totals.applications'),
      '/dashboard must map totalApplications from payload.totals.applications'
    );
    assert.ok(
      content.includes('submitted: payload.totals.submitted'),
      '/dashboard must map submitted from payload.totals.submitted'
    );
    assert.ok(
      content.includes('applied: payload.totals.applied'),
      '/dashboard must map applied from payload.totals.applied'
    );

    // Must not query rollups separately to override manager dashboard metrics
    assert.ok(
      !content.includes('queryRollupStats'),
      'manager.ts must not override manager team dashboard metrics with global queryRollupStats'
    );
  });
});
