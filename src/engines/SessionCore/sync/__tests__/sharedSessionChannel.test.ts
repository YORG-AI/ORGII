import { beforeEach, describe, expect, it, vi } from "vitest";

import { subscribeToSessionEvents } from "../useSessionChannel";

const mocks = vi.hoisted(() => {
  const channels: Array<{ onmessage?: (message: string) => void }> = [];
  return {
    channels,
    invoke: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel {
    onmessage?: (message: string) => void;

    constructor() {
      mocks.channels.push(this);
    }
  },
  invoke: mocks.invoke,
}));

vi.mock("@src/util/monitoring/apiTracker", () => ({
  recordPushEvent: vi.fn(),
}));

describe("shared session channel", () => {
  beforeEach(() => {
    mocks.channels.length = 0;
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "subscribe_session_events") return Promise.resolve(41);
      return Promise.resolve(undefined);
    });
  });

  it("uses one backend channel until the final consumer leaves", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = subscribeToSessionEvents("shared-session", first);
    const disposeSecond = subscribeToSessionEvents("shared-session", second);
    await Promise.resolve();

    expect(mocks.channels).toHaveLength(1);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    mocks.channels[0].onmessage?.(
      JSON.stringify({
        type: "agent:file_change",
        session_id: "shared-session",
      })
    );
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    disposeFirst();
    await Promise.resolve();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    disposeSecond();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "unsubscribe_session_events",
      { sessionId: "shared-session", channelId: 41 }
    );
  });
});
