import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Dashboard Modular Decomposition (PR 9)', () => {
  it('has extracted DashboardHeader.tsx with 2-tier header test IDs (Remedy 9A)', () => {
    const headerPath = path.resolve(process.cwd(), 'dashboard/components/Header/DashboardHeader.tsx');
    expect(fs.existsSync(headerPath)).toBe(true);

    const content = fs.readFileSync(headerPath, 'utf8');
    expect(content).toContain('data-testid="header-tier-1"');
    expect(content).toContain('data-testid="header-tier-2"');
    expect(content).toContain("setActiveTab('dashboard')");
    expect(content).toContain("setActiveTab('stats')");
  });

  it('has extracted CandidateSidebar.tsx component', () => {
    const sidebarPath = path.resolve(process.cwd(), 'dashboard/components/Queue/CandidateSidebar.tsx');
    expect(fs.existsSync(sidebarPath)).toBe(true);
  });

  it('has extracted useDashboardState hook', () => {
    const hookPath = path.resolve(process.cwd(), 'dashboard/hooks/useDashboardState.ts');
    expect(fs.existsSync(hookPath)).toBe(true);
  });
});
