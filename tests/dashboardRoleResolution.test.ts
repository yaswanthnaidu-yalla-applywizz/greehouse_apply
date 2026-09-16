import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isEmailAuthorizedForSignupSync,
  resolveEffectiveAppRole,
  resolveSignInRoleFromSources,
} from '../src/server/routes/auth.js';
import {
  isManagerViewAsOperator,
  isViewAsOperatorHeaderValue,
  resolveViewAsOperatorManagerEmail,
} from '../src/server/managerTeamScope.js';
import { requireOperatorDashboardAccess } from '../src/server/routes/requireRole.js';
import type { AuthenticatedRequest } from '../src/server/middleware/auth.js';

describe('dashboardRoleResolution', () => {
  it('resolveSignInRoleFromSources prefers email map over users.role', () => {
    assert.equal(
      resolveSignInRoleFromSources('balaji@applywizz.ai', 'operator'),
      'manager'
    );
  });

  it('resolveSignInRoleFromSources uses users.role when not in map', () => {
    assert.equal(resolveSignInRoleFromSources('ca@applywizz.ai', 'manager'), 'manager');
    assert.equal(resolveSignInRoleFromSources('ca@applywizz.ai', 'invalid'), 'operator');
  });

  it('resolveEffectiveAppRole prefers map over JWT', () => {
    assert.equal(resolveEffectiveAppRole('balaji@applywizz.ai', 'operator'), 'manager');
  });

  it('resolveEffectiveAppRole uses JWT when not in map', () => {
    assert.equal(resolveEffectiveAppRole('ca@applywizz.ai', 'admin'), 'admin');
    assert.equal(resolveEffectiveAppRole('ca@applywizz.ai', undefined), 'operator');
  });

  it('isEmailAuthorizedForSignupSync allows existing dashboard user without CA list', () => {
    assert.equal(
      isEmailAuthorizedForSignupSync('newca@applywizz.ai', [], true),
      true
    );
    assert.equal(
      isEmailAuthorizedForSignupSync('newca@applywizz.ai', [], false),
      false
    );
    assert.equal(
      isEmailAuthorizedForSignupSync('newca@applywizz.ai', ['newca@applywizz.ai'], false),
      true
    );
  });
});

describe('managerViewAsOperator', () => {
  it('isViewAsOperatorHeaderValue accepts operator case-insensitively', () => {
    assert.equal(isViewAsOperatorHeaderValue('operator'), true);
    assert.equal(isViewAsOperatorHeaderValue('Operator'), true);
    assert.equal(isViewAsOperatorHeaderValue('admin'), false);
    assert.equal(isViewAsOperatorHeaderValue(undefined), false);
  });

  it('resolveViewAsOperatorManagerEmail: manager uses JWT email and ignores forged header', () => {
    const req = {
      headers: {
        'x-view-as': 'operator',
        'x-view-as-manager-email': 'other@applywizz.ai',
      },
      user: { app_metadata: { role: 'manager' }, email: 'balaji@applywizz.ai' },
    } as unknown as AuthenticatedRequest;
    assert.equal(resolveViewAsOperatorManagerEmail(req), 'balaji@applywizz.ai');
  });

  it('resolveViewAsOperatorManagerEmail: dev requires manager email header', () => {
    const devWithManager = {
      headers: {
        'x-view-as': 'operator',
        'x-view-as-manager-email': 'balaji@applywizz.ai',
      },
      user: { app_metadata: { role: 'dev' }, email: 'yaswanthnaiduyalla@applywizz.ai' },
    } as unknown as AuthenticatedRequest;
    assert.equal(resolveViewAsOperatorManagerEmail(devWithManager), 'balaji@applywizz.ai');

    const devNoHeader = {
      headers: { 'x-view-as': 'operator' },
      user: { app_metadata: { role: 'dev' }, email: 'yaswanthnaiduyalla@applywizz.ai' },
    } as unknown as AuthenticatedRequest;
    assert.equal(resolveViewAsOperatorManagerEmail(devNoHeader), null);

    const devOperatorTarget = {
      headers: {
        'x-view-as': 'operator',
        'x-view-as-manager-email': 'ca@applywizz.ai',
      },
      user: { app_metadata: { role: 'dev' }, email: 'yaswanthnaiduyalla@applywizz.ai' },
    } as unknown as AuthenticatedRequest;
    assert.equal(resolveViewAsOperatorManagerEmail(devOperatorTarget), null);
  });

  it('isManagerViewAsOperator requires manager JWT role and header', () => {
    const base = {
      headers: { 'x-view-as': 'operator' },
      user: { app_metadata: { role: 'manager' } },
    } as unknown as AuthenticatedRequest;
    assert.equal(isManagerViewAsOperator(base), true);

    const operatorJwt = {
      headers: { 'x-view-as': 'operator' },
      user: { app_metadata: { role: 'operator' } },
    } as unknown as AuthenticatedRequest;
    assert.equal(isManagerViewAsOperator(operatorJwt), false);

    const noHeader = {
      headers: {},
      user: { app_metadata: { role: 'manager' } },
    } as unknown as AuthenticatedRequest;
    assert.equal(isManagerViewAsOperator(noHeader), false);
  });
});

describe('requireOperatorDashboardAccess', () => {
  it('allows manager with X-View-As operator when guard is active', () => {
    let called = false;
    const req = {
      headers: { 'x-view-as': 'operator', authorization: 'Bearer x' },
      user: { app_metadata: { role: 'manager' } },
    } as unknown as AuthenticatedRequest;
    const res = {
      status: () => ({ json: () => undefined }),
    } as any;
    requireOperatorDashboardAccess(req, res, () => {
      called = true;
    });
    assert.equal(called, true);
  });
});
