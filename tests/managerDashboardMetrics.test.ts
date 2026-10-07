import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Manager Dashboard Metrics Verification', () => {
  it('sources Manager summary metrics from the canonical application stats service', () => {
    const dashboardPath = path.resolve(process.cwd(), 'src/server/clientDashboard.ts');
    const content = fs.readFileSync(dashboardPath, 'utf8');
    assert.ok(content.includes('getApplicationStats('));
    assert.ok(content.includes('stats.counts.total'));
    assert.ok(content.includes('stats.counts.submitted'));
    assert.ok(content.includes('stats.counts.applied'));
    assert.ok(content.includes('statsAvailable: stats.available'));
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

  it('uses canonical date-based metrics for the Manager overview and stats routes', () => {
    const routePath = path.resolve(process.cwd(), 'src/server/routes/manager.ts');
    const content = fs.readFileSync(routePath, 'utf8');
    const overviewSection = content.slice(
      content.indexOf("managerRouter.get(['/overview', '/stats']"),
      content.indexOf("managerRouter.get('/applications'")
    );

    assert.ok(overviewSection.includes('getApplicationStats('));
    assert.ok(overviewSection.includes('applications: stats.counts.total'));
    assert.ok(overviewSection.includes('submitted: stats.counts.submitted'));
    assert.ok(overviewSection.includes('applied: stats.counts.applied'));
    assert.ok(overviewSection.includes('failed: stats.counts.failed'));
    assert.ok(overviewSection.includes('statsAvailable: stats.available'));
  });
});
