/**
 * @fileoverview WebSocket Manager for Greenhouse Operator Dashboard (Phase V2).
 *
 * Broadcasts real-time events to connected operator dashboard clients:
 * - APPLICATION_FAILED: Immediate toast/banner alert when worker encounters an error
 * - APPLICATION_STATUS_CHANGED: Status lifecycle transitions (APPLYING, APPLIED, FAILED, etc.)
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import axios from 'axios';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Ws');

export interface ApplicationFailedEvent {
  type: 'APPLICATION_FAILED';
  appId: string;
  reason: string;
  timestamp: string;
  jobUrl?: string;
  applywizzId?: string;
  companyName?: string;
  jobTitle?: string;
  proofFailedUrl?: string;
}

export type WebSocketMessage =
  | ApplicationFailedEvent
  | {
      type: 'APPLICATION_STATUS_CHANGED';
      appId: string;
      status: string;
      timestamp: string;
      [key: string]: any;
    };

class WebSocketManager {
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();

  /**
   * Initializes the WebSocketServer mounted on the HTTP server instance.
   */
  public init(server: Server): void {
    if (this.wss) return;

    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);
      log.info(`[WebSocket] 🔌 Operator dashboard connected. Active clients: ${this.clients.size}`);

      // Send initial heartbeat acknowledgment
      ws.send(JSON.stringify({ type: 'CONNECTED', timestamp: new Date().toISOString() }));

      ws.on('close', () => {
        this.clients.delete(ws);
        log.info(`[WebSocket] 🔌 Operator dashboard disconnected. Active clients: ${this.clients.size}`);
      });

      ws.on('error', (err) => {
        log.warn(`[WebSocket] ⚠️ Client socket error: ${err.message}`);
        this.clients.delete(ws);
      });
    });

    log.info('[WebSocket] 🚀 WebSocket server attached to /ws');
  }

  /**
   * Broadcasts a JSON event to all connected dashboard operator sessions.
   * If running on worker service (ENABLE_QUEUE_WORKER=true), forwards the event
   * via HTTP to Service 1's /api/internal/ws-broadcast endpoint.
   */
  public broadcast(message: WebSocketMessage): void {
    const webServiceUrl =
      process.env.WEB_SERVICE_URL ||
      (process.env.WORKER_SERVICE_URL
        ? process.env.WORKER_SERVICE_URL.replace('worker', 'main').replace('worker', 'greehouse_apply')
        : undefined);

    if (process.env.ENABLE_QUEUE_WORKER === 'true' && webServiceUrl) {
      const headers: Record<string, string> = {};
      if (process.env.INTERNAL_API_SECRET) {
        headers['x-internal-secret'] = process.env.INTERNAL_API_SECRET;
      }
      axios
        .post(`${webServiceUrl}/api/internal/ws-broadcast`, message, { timeout: 5000, headers })
        .catch((err: any) => {
          log.warn(`[WebSocket] ⚠️ Failed to forward WS event to web service (${webServiceUrl}): ${err.message}`);
        });
      return;
    }

    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(payload);
        } catch (err: any) {
          log.warn(`[WebSocket] ⚠️ Error broadcasting to client: ${err.message}`);
        }
      }
    }
  }

  /**
   * Broadcasts APPLICATION_STATUS_CHANGED event.
   */
  public broadcastApplicationStatusChange(event: {
    appId: string;
    status: string;
    timestamp?: string;
    [key: string]: any;
  }): void {
    const { appId, status, timestamp, ...rest } = event;
    this.broadcast({
      type: 'APPLICATION_STATUS_CHANGED',
      appId,
      status,
      timestamp: timestamp || new Date().toISOString(),
      ...rest,
    });
  }

  /**
   * Emits APPLICATION_FAILED event to all active sessions.
   */
  public emitApplicationFailed(params: {
    appId: string;
    reason: string;
    timestamp?: string;
    jobUrl?: string;
    applywizzId?: string;
    companyName?: string;
    jobTitle?: string;
    proofFailedUrl?: string;
  }): void {
    const event: ApplicationFailedEvent = {
      type: 'APPLICATION_FAILED',
      appId: params.appId,
      reason: params.reason,
      timestamp: params.timestamp || new Date().toISOString(),
      jobUrl: params.jobUrl,
      applywizzId: params.applywizzId,
      companyName: params.companyName,
      jobTitle: params.jobTitle,
      proofFailedUrl: params.proofFailedUrl,
    };
    log.info(`[WebSocket] 📢 Broadcasting APPLICATION_FAILED for ${params.appId}: ${params.reason}`);
    this.broadcast(event);
  }

  public getConnectedClientsCount(): number {
    return this.clients.size;
  }
}

export const wsManager = new WebSocketManager();
