import type {
  JsonRpcInbound,
  JsonRpcNotification,
  JsonRpcRequest,
  MobileRpcError,
} from "./types";
import { isJsonRpcResponse } from "./types";

export type RpcNotificationHandler = (
  method: string,
  params: Record<string, unknown> | undefined
) => void;

export interface MobileRpcClient {
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  notify(method: string, params?: Record<string, unknown>): void;
  onNotification(handler: RpcNotificationHandler): () => void;
  close(): void;
  get readyState(): number;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: number;
}

const CLOSED = 3;
const MAX_PENDING_CALLS = 128;
const RPC_TIMEOUT_MS = 15_000;

export function createMobileRpcClient(socket: WebSocket): MobileRpcClient {
  let nextId = 1;
  const pending = new Map<number, PendingCall>();
  const notificationHandlers = new Set<RpcNotificationHandler>();

  const flushPending = (error: Error) => {
    for (const entry of pending.values()) {
      window.clearTimeout(entry.timeoutId);
      entry.reject(error);
    }
    pending.clear();
  };

  socket.addEventListener("message", (event) => {
    let parsed: JsonRpcInbound;
    try {
      parsed = JSON.parse(String(event.data)) as JsonRpcInbound;
    } catch {
      return;
    }

    if (isJsonRpcResponse(parsed)) {
      const waiter = pending.get(parsed.id);
      if (!waiter) return;
      pending.delete(parsed.id);
      window.clearTimeout(waiter.timeoutId);
      if (parsed.error) {
        waiter.reject(
          new Error(parsed.error.message || `RPC error ${parsed.error.code}`)
        );
        return;
      }
      waiter.resolve(parsed.result);
      return;
    }

    const notification = parsed as JsonRpcNotification;
    for (const handler of notificationHandlers) {
      handler(notification.method, notification.params);
    }
  });

  socket.addEventListener("close", () => {
    flushPending(new Error("WebSocket closed"));
  });

  return {
    get readyState() {
      return socket.readyState;
    },
    call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("WebSocket is not open"));
      }
      if (pending.size >= MAX_PENDING_CALLS) {
        return Promise.reject(new Error("Too many pending RPC calls"));
      }
      const id = nextId++;
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };
      return new Promise<T>((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC call timed out: ${method}`));
        }, RPC_TIMEOUT_MS);
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
          timeoutId,
        });
        socket.send(JSON.stringify(request));
      });
    },
    notify(method: string, params: Record<string, unknown> = {}) {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    },
    onNotification(handler: RpcNotificationHandler) {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    close() {
      if (socket.readyState !== CLOSED) {
        socket.close();
      }
      flushPending(new Error("RPC client closed"));
    },
  };
}

export function toMobileRpcError(error: unknown): MobileRpcError {
  if (error instanceof Error) {
    return { code: -1, message: error.message };
  }
  return { code: -1, message: String(error) };
}
