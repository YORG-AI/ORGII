/**
 * Code Editor WebSocket Client
 *
 * Connects to the unified Rust HTTP server (port 13847) WebSocket for real-time
 * code-editor events:
 * - File watcher updates (repo:status_updated, file:changed)
 * - Git operation updates (repo:git_operation)
 * - Git status changes
 *
 * This replaces the unreliable Tauri event system for push notifications.
 */
import { IDE_SERVER_WS_URL } from "@src/config/ideServer";
import { createLogger } from "@src/hooks/logger";
import { recordPushEvent } from "@src/util/monitoring/apiTracker";

import {
  type ParsedCodeEditorWebSocketMessage,
  maybeParseCodeEditorWebSocketMessage,
} from "./websocket/schemas";

const log = createLogger("CodeEditorWS");

export type CodeEditorWebSocketMessage = ParsedCodeEditorWebSocketMessage;

type EventHandler<T = CodeEditorWebSocketMessage> = (data: T) => void;

export class CodeEditorWebSocketClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000; // Start with 1s
  private maxReconnectDelay = 30000; // Max 30s
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;
  private isIntentionallyClosed = false;

  constructor(url = IDE_SERVER_WS_URL) {
    this.url = url;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      this.isIntentionallyClosed = false;

      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          this.reconnectAttempts = 0;
          this.reconnectDelay = 1000;
          this.emit("connected", { timestamp: Date.now() });
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const data = maybeParseCodeEditorWebSocketMessage(event.data);
            if (data === null) return;
            recordPushEvent("ws", `in · ${data.type ?? "message"}`);
            this.handleMessage(data);
          } catch (err) {
            log.error("[CodeEditorWS] Failed to parse message:", err);
          }
        };

        this.ws.onclose = (event) => {
          this.emit("disconnected", { code: event.code, reason: event.reason });

          // Auto-reconnect if not intentionally closed
          if (
            !this.isIntentionallyClosed &&
            !event.wasClean &&
            this.reconnectAttempts < this.maxReconnectAttempts
          ) {
            this.scheduleReconnect();
          }
        };

        this.ws.onerror = (error) => {
          log.error("[CodeEditorWS] WebSocket error:", error);
          reject(error);
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  disconnect(): void {
    this.isIntentionallyClosed = true;
    this.cancelReconnect();

    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  on<T extends CodeEditorWebSocketMessage = CodeEditorWebSocketMessage>(
    eventType: string | "*",
    handler: EventHandler<T>
  ): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler as EventHandler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(eventType)?.delete(handler as EventHandler);
    };
  }

  onAny(handler: EventHandler): () => void {
    return this.on("*", handler);
  }

  off(eventType: string | "*"): void {
    this.handlers.delete(eventType);
  }

  removeAllListeners(): void {
    this.handlers.clear();
  }

  private handleMessage(data: CodeEditorWebSocketMessage): void {
    const eventType = data.type;

    // Emit to specific event type handlers
    this.emit(eventType, data);

    // Emit to wildcard handlers
    this.emit("*", data);
  }

  private emit(eventType: string, data: unknown): void {
    const handlers = this.handlers.get(eventType);
    if (handlers && handlers.size > 0) {
      for (const handler of handlers) {
        try {
          handler(data as CodeEditorWebSocketMessage);
        } catch (err) {
          log.error(`Handler error for ${eventType}:`, err);
        }
      }
    }
  }

  private scheduleReconnect(): void {
    this.cancelReconnect();
    this.reconnectAttempts++;

    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        log.error("[CodeEditorWS] Reconnect failed:", err);
      });
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// Global singleton instance
let wsClientInstance: CodeEditorWebSocketClient | null = null;

export function getCodeEditorWebSocket(): CodeEditorWebSocketClient | null {
  return wsClientInstance;
}

// Initialize on module load in the app. Unit tests import broad UI graphs in
// jsdom; opening a real socket there leaks asynchronous undici events across
// test files and can fail after the owning test has already completed.
if (typeof window !== "undefined" && process.env.NODE_ENV !== "test") {
  // Auto-connect when app loads
  wsClientInstance = new CodeEditorWebSocketClient();
  wsClientInstance.connect().catch((err) => {
    log.error("[CodeEditorWS] Failed to connect on init:", err);
  });

  // Expose globally for debugging
  (
    window as unknown as { __codeEditorWebSocket__: CodeEditorWebSocketClient }
  ).__codeEditorWebSocket__ = wsClientInstance;
}
