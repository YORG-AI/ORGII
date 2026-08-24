// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  disposeCodeEditorWebSocket,
  getCodeEditorWebSocket,
  initializeCodeEditorWebSocket,
} from "./codeEditorWebSocket";

describe("code editor WebSocket lifecycle", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const OriginalWebSocket = globalThis.WebSocket;

  afterEach(() => {
    disposeCodeEditorWebSocket();
    process.env.NODE_ENV = originalNodeEnv;
    globalThis.WebSocket = OriginalWebSocket;
    vi.restoreAllMocks();
  });

  it("does not connect merely because a shared browser graph imports the module", () => {
    expect(getCodeEditorWebSocket()).toBeNull();
  });

  it("connects once when the desktop startup owner initializes it and disposes cleanly", () => {
    let constructed = 0;
    let closed = 0;

    class FakeWebSocket {
      static readonly OPEN = 1;
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(_url: string | URL) {
        constructed += 1;
      }

      close(): void {
        closed += 1;
      }
    }

    process.env.NODE_ENV = "development";
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const first = initializeCodeEditorWebSocket();
    const second = initializeCodeEditorWebSocket();

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(constructed).toBe(1);

    disposeCodeEditorWebSocket();
    expect(closed).toBe(1);
    expect(getCodeEditorWebSocket()).toBeNull();
  });
});
