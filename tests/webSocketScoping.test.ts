import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import WebSocket from 'ws';
import { wsManager } from '../src/server/ws.js';

describe('Authenticated WebSocket Scoping', () => {
  let server: http.Server;
  let port: number;

  before(async () => {
    server = http.createServer();
    wsManager.init(server);
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    port = (server.address() as any).port;
  });

  after(async () => {
    wsManager.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('unauthenticated connection without token is rejected with 401', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode || 0));
      ws.on('error', () => {});
    });
    assert.equal(status, 401);
  });

  test('connection with invalid token is rejected with 403', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?token=invalid-token`);
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode || 0));
      ws.on('error', () => {});
    });
    assert.equal(status, 403);
  });

  test('authenticated connection with valid token is accepted', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?token=valid-test-token&role=admin`);
    const opened = await new Promise<boolean>((resolve, reject) => {
      ws.on('open', () => resolve(true));
      ws.on('error', (err) => reject(err));
      ws.on('unexpected-response', (_req, res) => reject(new Error(`Unexpected response ${res.statusCode}`)));
    });
    assert.equal(opened, true);
    ws.close();
  });

  test('broadcasting with applywizzId filters to only sockets with access', async () => {
    // Client 1: Operator for AW-001
    const wsOp1 = new WebSocket(`ws://localhost:${port}/ws?token=test-token-op1&role=operator&candidates=AW-001`);
    // Client 2: Operator for AW-002
    const wsOp2 = new WebSocket(`ws://localhost:${port}/ws?token=test-token-op2&role=operator&candidates=AW-002`);
    // Client 3: Admin
    const wsAdmin = new WebSocket(`ws://localhost:${port}/ws?token=test-token-admin&role=admin`);

    await Promise.all([
      new Promise((resolve) => wsOp1.on('open', resolve)),
      new Promise((resolve) => wsOp2.on('open', resolve)),
      new Promise((resolve) => wsAdmin.on('open', resolve)),
    ]);

    const op1Messages: any[] = [];
    const op2Messages: any[] = [];
    const adminMessages: any[] = [];

    wsOp1.on('message', (data) => {
      const parsed = JSON.parse(data.toString());
      if (parsed.type !== 'CONNECTED') op1Messages.push(parsed);
    });
    wsOp2.on('message', (data) => {
      const parsed = JSON.parse(data.toString());
      if (parsed.type !== 'CONNECTED') op2Messages.push(parsed);
    });
    wsAdmin.on('message', (data) => {
      const parsed = JSON.parse(data.toString());
      if (parsed.type !== 'CONNECTED') adminMessages.push(parsed);
    });

    // 1. Broadcast event for AW-001
    wsManager.broadcast({
      type: 'APPLICATION_FAILED',
      appId: 'app-for-aw001',
      applywizzId: 'AW-001',
      reason: 'Missing field',
      timestamp: new Date().toISOString(),
    });

    // 2. Broadcast event without applywizzId (broadcast to all)
    wsManager.broadcast({
      type: 'APPLICATION_STATUS_CHANGED',
      appId: 'global-app',
      status: 'APPLYING',
      timestamp: new Date().toISOString(),
    });

    // Wait a brief tick for message propagation
    await new Promise((resolve) => setTimeout(resolve, 50));

    // op1 should see both messages (AW-001 and global)
    assert.equal(op1Messages.length, 2);
    assert.equal(op1Messages[0].appId, 'app-for-aw001');
    assert.equal(op1Messages[1].appId, 'global-app');

    // op2 should see ONLY the global message (NOT AW-001)
    assert.equal(op2Messages.length, 1);
    assert.equal(op2Messages[0].appId, 'global-app');

    // admin should see both messages
    assert.equal(adminMessages.length, 2);
    assert.equal(adminMessages[0].appId, 'app-for-aw001');
    assert.equal(adminMessages[1].appId, 'global-app');

    wsOp1.close();
    wsOp2.close();
    wsAdmin.close();
  });
});
