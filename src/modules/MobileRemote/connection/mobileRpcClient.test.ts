// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { createMobileRpcClient } from "./mobileRpcClient";

type WebSocketListener = (event: { data: string }) => void;

function createMockSocket() {
  const listeners = new Map<string, Set<WebSocketListener>>();
  const socket = {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: (type: string, listener: WebSocketListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    emit(type: string, data: string) {
      for (const listener of listeners.get(type) ?? []) {
        listener({ data });
      }
    },
  };
  return socket;
}

describe("createMobileRpcClient", () => {
  it("resolves call results by id", async () => {
    const socket = createMockSocket();
    const client = createMobileRpcClient(socket as unknown as WebSocket);
    const promise = client.call<{ ok: boolean }>("initialize", {
      protocolVersion: 1,
    });
    expect(socket.send).toHaveBeenCalledOnce();
    socket.emit(
      "message",
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })
    );
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("rejects on rpc error", async () => {
    const socket = createMockSocket();
    const client = createMobileRpcClient(socket as unknown as WebSocket);
    const promise = client.call("session/list");
    socket.emit(
      "message",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: 401, message: "Unauthorized" },
      })
    );
    await expect(promise).rejects.toThrow("Unauthorized");
  });

  it("dispatches notifications without id", () => {
    const socket = createMockSocket();
    const client = createMobileRpcClient(socket as unknown as WebSocket);
    const handler = vi.fn();
    client.onNotification(handler);
    socket.emit(
      "message",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "orgii/event",
        params: { channel: "bus" },
      })
    );
    expect(handler).toHaveBeenCalledWith("orgii/event", { channel: "bus" });
  });

  it("bounds an unanswered call with a timeout", async () => {
    vi.useFakeTimers();
    try {
      const socket = createMockSocket();
      const client = createMobileRpcClient(socket as unknown as WebSocket);
      const promise = client.call("session/list");
      const expectation = expect(promise).rejects.toThrow(
        "RPC call timed out: session/list"
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects outstanding calls when the socket closes", async () => {
    const socket = createMockSocket();
    const client = createMobileRpcClient(socket as unknown as WebSocket);
    const promise = client.call("session/list");
    socket.emit("close", "");
    await expect(promise).rejects.toThrow("WebSocket closed");
  });
});
