/**
 * @fileoverview WebSocket Manager for Greenhouse Operator Dashboard (Phase V2).
 *
 * Broadcasts real-time events to connected operator dashboard clients:
 * - APPLICATION_FAILED: Immediate toast/banner alert when worker encounters an error
 * - APPLICATION_STATUS_CHANGED: Status lifecycle transitions (APPLYING, APPLIED, FAILED, etc.)
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';

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
      console.log(`[WebSocket] 🔌 Operator dashboard connected. Active clients: ${this.clients.size}`);

      // Send initial heartbeat acknowledgment
      ws.send(JSON.stringify({ type: 'CONNECTED', timestamp: new Date().toISOString() }));

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`[WebSocket] 🔌 Operator dashboard disconnected. Active clients: ${this.clients.size}`);
      });

      ws.on('error', (err) => {
        console.warn(`[WebSocket] ⚠️ Client socket error: ${err.message}`);
        this.clients.delete(ws);
      });
    });

    console.log('[WebSocket] 🚀 WebSocket server attached to /ws');
  }

  /**
   * Broadcasts a JSON event to all connected dashboard operator sessions.
   */
  public broadcast(message: WebSocketMessage): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(payload);
        } catch (err: any) {
          console.warn(`[WebSocket] ⚠️ Error broadcasting to client: ${err.message}`);
        }
      }
    }
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
    console.log(`[WebSocket] 📢 Broadcasting APPLICATION_FAILED for ${params.appId}: ${params.reason}`);
    this.broadcast(event);
  }

  public getConnectedClientsCount(): number {
    return this.clients.size;
  }
}

export const wsManager = new WebSocketManager();
