/**
 * WebSocket Client
 *
 * Global singleton WebSocket client for real-time session events.
 *
 * Protocol:
 *   1. Connect: ws://server/api/ws?session_id=xxx
 *   2. Receive events for that session
 *
 * Features:
 * - Single persistent connection per session
 * - Automatic reconnection with exponential backoff
 * - Ping/pong keep-alive
 * - Global debug mode via window.__ORGII_WS_DEBUG__
 */
import { createLogger } from "@src/hooks/logger";
import { recordPushEvent } from "@src/util/monitoring/apiTracker";

import { parseWSMessage } from "./schemas";
import type { WSEventType, WSMessage } from "./types";

const moduleLog = createLogger("OrgiiaiWS");

interface WSDebugLog {
  timestamp: string;
  direction: "in" | "out";
  type: string;
  data: unknown;
}

let globalDebugEnabled = false;
const debugLogs: WSDebugLog[] = [];
const MAX_DEBUG_LOGS = 500;

const wsDebug = {
  enable: () => {
    globalDebugEnabled = true;
  },
  disable: () => {
    globalDebugEnabled = false;
  },
  isEnabled: () => globalDebugEnabled,
  logs: (filter?: string) => {
    if (filter) {
      return debugLogs.filter((log) => log.type.includes(filter));
    }
    return [...debugLogs];
  },
  clear: () => {
    debugLogs.length = 0;
  },
  recent: (count = 10) => {
    const recent = debugLogs.slice(-count);
    moduleLog.debug(
      recent.map((log) => ({
        time: log.timestamp,
        dir: log.direction === "in" ? "⬅️ IN" : "➡️ OUT",
        type: log.type,
        preview: JSON.stringify(log.data).slice(0, 100),
      }))
    );
    return recent;
  },
  filter: (type: string) => {
    const filtered = debugLogs.filter((_log) => _log.type === type);
    return filtered;
  },
  agentEvents: () => {
    return wsDebug.filter("agent.event");
  },
  toolCalls: () => {
    const filtered = debugLogs.filter((log) => {
      if (log.type !== "agent.event") return false;
      const data = log.data as { event_type?: string };
      return data.event_type === "tool_call_end";
    });
    return filtered;
  },
  messages: () => {
    const filtered = debugLogs.filter((log) => {
      if (log.type !== "agent.event") return false;
      const data = log.data as { event_type?: string };
      return data.event_type === "message";
    });
    return filtered;
  },
  thinking: () => {
    const filtered = debugLogs.filter((log) => {
      if (log.type !== "agent.event") return false;
      const data = log.data as { event_type?: string };
      return data.event_type === "thinking";
    });
    return filtered;
  },
  activities: () => {
    return wsDebug.filter("session.activity");
  },
};

function addDebugLog(direction: "in" | "out", type: string, data: unknown) {
  if (!globalDebugEnabled) return;

  const log: WSDebugLog = {
    timestamp: new Date().toISOString().slice(11, 23),
    direction,
    type,
    data,
  };

  debugLogs.push(log);

  if (debugLogs.length > MAX_DEBUG_LOGS) {
    debugLogs.shift();
  }

  const _dirIcon = direction === "in" ? "⬅️" : "➡️";
  const _color = direction === "in" ? "#4ade80" : "#60a5fa";
  // Debug display placeholders - used for console logging when enabled
}

if (typeof window !== "undefined") {
  (
    window as unknown as { __ORGII_WS_DEBUG__: typeof wsDebug }
  ).__ORGII_WS_DEBUG__ = wsDebug;
}

type EventHandler<T = WSMessage> = (data: T) => void;

export interface OrgiiaiWSClientOptions {
  pingInterval?: number;
  maxReconnectAttempts?: number;
  initialReconnectDelay?: number;
  maxReconnectDelay?: number;
  debug?: boolean;
  /** Starting cursor for Redis Streams resumption (hosted_key sessions only) */
  startFrom?: string;
  /**
   * Callback invoked before each reconnection attempt.
   * Use this to refresh cursor from local storage for hosted_key sessions.
   * Returns the new cursor to use for the reconnection.
   */
  onBeforeReconnect?: () => Promise<string | void>;
}

const DEFAULT_OPTIONS: Required<
  Omit<OrgiiaiWSClientOptions, "onBeforeReconnect">
> &
  Pick<OrgiiaiWSClientOptions, "onBeforeReconnect"> = {
  pingInterval: 30000,
  maxReconnectAttempts: 5,
  initialReconnectDelay: 1000,
  maxReconnectDelay: 30000,
  debug: false,
  startFrom: "$",
  onBeforeReconnect: undefined,
};

export class OrgiiaiWSClient {
  private ws: WebSocket | null = null;
  private baseUrl: string;
  private sessionId: string;
  private options: typeof DEFAULT_OPTIONS;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private reconnectAttempts = 0;
  private reconnectDelay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    baseUrl: string,
    sessionId: string,
    options: OrgiiaiWSClientOptions = {}
  ) {
    this.baseUrl = baseUrl;
    this.sessionId = sessionId;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.reconnectDelay = this.options.initialReconnectDelay;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      // Build URL with session_id and optional start_from for hosted_key session resumption
      let url = `${this.baseUrl}?session_id=${encodeURIComponent(this.sessionId)}`;
      if (this.options.startFrom && this.options.startFrom !== "$") {
        url += `&start_from=${encodeURIComponent(this.options.startFrom)}`;
      }

      try {
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
          this.reconnectAttempts = 0;
          this.reconnectDelay = this.options.initialReconnectDelay;
          this.startPing();
          // Emit "connected" event so provider can update connected state
          this.emit("connected", { sessionId: this.sessionId });
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const data = parseWSMessage(event.data);
            this.handleMessage(data);
          } catch (err) {
            moduleLog.error("[OrgiiaiWS] Parse error:", err);
          }
        };

        this.ws.onclose = (event) => {
          this.stopPing();

          if (
            !event.wasClean &&
            this.reconnectAttempts < this.options.maxReconnectAttempts
          ) {
            this.scheduleReconnect();
          }

          this.emit("disconnected", { code: event.code, reason: event.reason });
        };

        this.ws.onerror = (error) => {
          reject(error);
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  disconnect(): void {
    this.stopPing();
    this.cancelReconnect();

    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }

    this.removeAllListeners();
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get currentSessionId(): string {
    return this.sessionId;
  }

  /**
   * Update the start_from cursor for reconnection
   * Used when resuming hosted_key session activity streams
   */
  setStartFrom(cursor: string): void {
    this.options.startFrom = cursor;
  }

  /**
   * Get current start_from cursor
   */
  get startFrom(): string {
    return this.options.startFrom;
  }

  on<T extends WSMessage = WSMessage>(
    eventType: WSEventType | "*",
    handler: EventHandler<T>
  ): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler as EventHandler);

    return () => {
      this.handlers.get(eventType)?.delete(handler as EventHandler);
    };
  }

  onAny(handler: EventHandler): () => void {
    return this.on("*", handler);
  }

  once<T extends WSMessage = WSMessage>(
    eventType: WSEventType,
    handler: EventHandler<T>
  ): () => void {
    const wrappedHandler = (data: T) => {
      unsubscribe();
      handler(data);
    };
    const unsubscribe = this.on(eventType, wrappedHandler);
    return unsubscribe;
  }

  off(eventType: WSEventType | "*"): void {
    this.handlers.delete(eventType);
  }

  removeAllListeners(): void {
    this.handlers.clear();
  }

  private handleMessage(data: WSMessage): void {
    const eventType = data.type as WSEventType;
    recordPushEvent("ws", `in · ${eventType}`);
    addDebugLog("in", eventType, data);
    this.emit(eventType, data);
    this.emit("*", data);
  }

  private emit(eventType: string, data: unknown): void {
    const handlers = this.handlers.get(eventType);
    if (handlers && handlers.size > 0) {
      for (const handler of handlers) {
        try {
          handler(data as WSMessage);
        } catch (err) {
          moduleLog.error(`[OrgiiaiWS] Handler error for ${eventType}:`, err);
        }
      }
    } else {
      if (globalDebugEnabled && eventType === "agent.event") {
        moduleLog.warn(
          `%c[OrgiiaiWS] ⚠️ No handlers registered for ${eventType}`,
          "color: #F59E0B;",
          {
            registeredTypes: Array.from(this.handlers.keys()),
          }
        );
      }
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      addDebugLog("out", (message.type as string) || "unknown", message);
      this.ws.send(JSON.stringify(message));
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.isConnected) {
        this.send({ type: "ping" });
      }
    }, this.options.pingInterval);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.cancelReconnect();
    this.reconnectAttempts++;

    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.options.maxReconnectDelay
    );

    this.reconnectTimer = setTimeout(async () => {
      try {
        // Call onBeforeReconnect to refresh cursor before reconnecting
        // This ensures we resume from the latest stored position
        if (this.options.onBeforeReconnect) {
          const newCursor = await this.options.onBeforeReconnect();
          if (newCursor) {
            this.options.startFrom = newCursor;
          }
        }
        await this.connect();
      } catch (err) {
        moduleLog.error("[OrgiiaiWS] Reconnect failed:", err);
      }
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

let wsClientInstance: OrgiiaiWSClient | null = null;

export function getWSClient(): OrgiiaiWSClient | null {
  return wsClientInstance;
}

export function initWSClient(
  baseUrl: string,
  sessionId: string,
  options?: OrgiiaiWSClientOptions
): OrgiiaiWSClient {
  if (wsClientInstance) {
    wsClientInstance.disconnect();
  }
  wsClientInstance = new OrgiiaiWSClient(baseUrl, sessionId, options);
  return wsClientInstance;
}

export function destroyWSClient(): void {
  if (wsClientInstance) {
    wsClientInstance.disconnect();
    wsClientInstance = null;
  }
}

export { wsDebug as WSDebug };
export type { WSDebugLog };
