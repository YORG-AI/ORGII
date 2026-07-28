import { afterEach, beforeEach, vi } from "vitest";

import { invokeTauri, isTauriReady } from "@src/util/platform/tauri/init";

import { unregisterPane } from "../terminalOutputScheduler";

class FakeMessageChannel {
  port1: FakeMessagePort;
  port2: FakeMessagePort;

  constructor() {
    this.port1 = new FakeMessagePort();
    this.port2 = new FakeMessagePort();
    this.port1._peer = this.port2;
    this.port2._peer = this.port1;
  }
}

class FakeMessagePort {
  onmessage: ((evt: { data: unknown }) => void) | null = null;
  _peer!: FakeMessagePort;
  _started = false;

  start() {
    this._started = true;
  }

  close() {
    this.onmessage = null;
  }

  postMessage(data: unknown) {
    const peer = this._peer;
    setTimeout(() => {
      if (peer.onmessage) {
        peer.onmessage({ data });
      }
    }, 0);
  }
}

export const SESSION_A = "test-session-a";
export const SESSION_B = "test-session-b";

export function makeWrite() {
  const calls: string[] = [];
  const fn = vi.fn((data: string | Uint8Array) => {
    calls.push(
      typeof data === "string" ? data : new TextDecoder().decode(data)
    );
  });
  return { fn, calls };
}

export async function flushTimers() {
  await vi.runAllTimersAsync();
}

beforeEach(() => {
  vi.useFakeTimers();

  // restoreAllMocks strips these implementations after every case.
  vi.mocked(isTauriReady).mockReturnValue(true);
  vi.mocked(invokeTauri).mockResolvedValue(undefined);

  global.MessageChannel =
    FakeMessageChannel as unknown as typeof MessageChannel;

  unregisterPane(SESSION_A);
  unregisterPane(SESSION_B);
});

afterEach(() => {
  unregisterPane(SESSION_A);
  unregisterPane(SESSION_B);
  vi.useRealTimers();
  vi.restoreAllMocks();
  // @ts-expect-error - cleaning up polyfill
  delete global.MessageChannel;
});
