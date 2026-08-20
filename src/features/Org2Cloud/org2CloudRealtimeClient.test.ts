import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOrg2CloudRealtimeConnection } from "./org2CloudRealtimeClient";

vi.mock("./config", () => ({
  getCloudEndpoint: () => ({
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon-key",
    isOfficial: true,
  }),
}));

interface ChannelCall {
  readonly name: string;
  readonly opts?: Record<string, unknown>;
}

const channelCalls: ChannelCall[] = [];
const createdChannels: ReturnType<typeof makeFakeChannel>[] = [];
const setAuthMock = vi.fn();

function makeFakeChannel() {
  let subscribeCallback: ((status: string) => void) | undefined;
  const channel = {
    on: vi.fn(() => channel),
    subscribe: vi.fn((callback?: (status: string) => void) => {
      subscribeCallback = callback;
      return channel;
    }),
    track: vi.fn((_payload: Record<string, unknown>) => Promise.resolve("ok")),
    untrack: vi.fn(() => Promise.resolve("ok")),
    send: vi.fn(() => Promise.resolve("ok")),
    presenceState: vi.fn(() => ({})),
    emitStatus: (status: string) => subscribeCallback?.(status),
  };
  return channel;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    realtime: { setAuth: setAuthMock, disconnect: vi.fn() },
    channel: vi.fn((name: string, opts?: Record<string, unknown>) => {
      channelCalls.push({ name, opts });
      const channel = makeFakeChannel();
      createdChannels.push(channel);
      return channel;
    }),
    removeChannel: vi.fn(() => Promise.resolve("ok")),
    removeAllChannels: vi.fn(() => Promise.resolve("ok")),
  })),
}));

const flushJoins = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("createOrg2CloudRealtimeConnection presence privacy", () => {
  beforeEach(() => {
    channelCalls.length = 0;
    createdChannels.length = 0;
    setAuthMock.mockClear();
    vi.mocked(createClient).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("opens the presence/broadcast channel as private with the presence key", async () => {
    const conn = createOrg2CloudRealtimeConnection(async () => "token-abc");
    conn.joinPresence({
      scope: "org:org-123",
      key: "user-9",
      payload: { displayName: "Ada" },
      onSync: () => undefined,
      onBroadcast: () => undefined,
    });

    const call = channelCalls.find((c) => c.name === "presence:org:org-123");
    expect(call).toBeDefined();
    expect(call?.opts).toEqual({
      config: { private: true, presence: { key: "user-9" } },
    });
  });

  it("surfaces presence-channel subscription edges through onStatus", async () => {
    const conn = createOrg2CloudRealtimeConnection(async () => "token-abc");
    const edges: boolean[] = [];
    conn.joinPresence({
      scope: "org:org-123",
      key: "user-9",
      payload: null,
      onSync: () => undefined,
      onStatus: (subscribed) => edges.push(subscribed),
    });
    const channel = createdChannels.at(-1);
    await flushJoins();
    channel?.emitStatus("SUBSCRIBED");
    await flushJoins();
    channel?.emitStatus("CHANNEL_ERROR");
    await flushJoins();
    channel?.emitStatus("SUBSCRIBED");
    await flushJoins();
    channel?.emitStatus("CLOSED");
    expect(edges).toEqual([true, false, true, false]);
  });

  it("wires the token callback into the client and arms callback-based auth", async () => {
    const getToken = async () => "token-abc";
    createOrg2CloudRealtimeConnection(getToken);
    const options = vi.mocked(createClient).mock.calls.at(-1)?.[2] as {
      accessToken?: () => Promise<string | null>;
    };
    expect(options.accessToken).toBe(getToken);
    expect(setAuthMock).toHaveBeenCalledWith();
  });

  it("re-resolves the callback token when nudged after a rotation", async () => {
    const conn = createOrg2CloudRealtimeConnection(async () => "token-abc");
    setAuthMock.mockClear();
    conn.setAuth();
    expect(setAuthMock).toHaveBeenCalledWith();
  });

  it("leaves table-change channels public (postgres_changes are gated by table RLS, not realtime.messages)", async () => {
    const conn = createOrg2CloudRealtimeConnection(async () => "token-abc");
    conn.subscribe({
      table: "org_memberships",
      filter: "org_id=eq.org-123",
      onChange: () => undefined,
    });

    const call = channelCalls.find((c) =>
      c.name.startsWith("org2:org_memberships")
    );
    expect(call).toBeDefined();
    expect(call?.opts).toBeUndefined();
  });

  it("uses a fresh topic for a fast same-filter resubscribe", async () => {
    const conn = createOrg2CloudRealtimeConnection(async () => "token-abc");
    const options = {
      table: "org_memberships",
      filter: "org_id=eq.org-123",
      onChange: () => undefined,
    };

    const leaveFirst = conn.subscribe(options);
    leaveFirst();
    conn.subscribe(options);

    const calls = channelCalls.filter((call) =>
      call.name.startsWith("org2:org_memberships:org_id=eq.org-123")
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.name).not.toBe(calls[1]?.name);
  });

  it("serializes and coalesces rapid presence updates while track is in flight", async () => {
    let releaseInitialTrack: (() => void) | undefined;
    const initialTrack = new Promise<string>((resolve) => {
      releaseInitialTrack = () => resolve("ok");
    });
    const conn = createOrg2CloudRealtimeConnection(async () => "token-abc");
    const handle = conn.joinPresence({
      scope: "org:org-123",
      key: "user-9",
      payload: { viewingSessionId: null, updatedAt: 1 },
      onSync: () => undefined,
    });
    const channel = createdChannels.at(-1);
    expect(channel).toBeDefined();
    channel?.track.mockImplementationOnce(() => initialTrack);

    await flushJoins();
    channel?.emitStatus("SUBSCRIBED");
    await Promise.resolve();
    handle.update({ viewingSessionId: null, updatedAt: 2 });
    handle.update({ viewingSessionId: "session-1", updatedAt: 3 });
    expect(channel?.track).toHaveBeenCalledTimes(1);

    releaseInitialTrack?.();
    await initialTrack;
    await vi.waitFor(() => expect(channel?.track).toHaveBeenCalledTimes(2));
    expect(channel?.track.mock.calls.at(-1)?.[0]).toEqual({
      viewingSessionId: "session-1",
      updatedAt: 3,
    });
  });

  it("does not track before a view and publishes an explicit idle view on close", async () => {
    const conn = createOrg2CloudRealtimeConnection(async () => "token-abc");
    const handle = conn.joinPresence({
      scope: "org:org-123",
      key: "user-9",
      payload: null,
      onSync: () => undefined,
    });
    const channel = createdChannels.at(-1);

    await flushJoins();
    channel?.emitStatus("SUBSCRIBED");
    await Promise.resolve();
    expect(channel?.track).not.toHaveBeenCalled();
    expect(channel?.untrack).not.toHaveBeenCalled();

    handle.update({ viewingSessionId: "session-1", updatedAt: 2 });
    await vi.waitFor(() => expect(channel?.track).toHaveBeenCalledTimes(1));

    handle.update(null);
    await vi.waitFor(() => expect(channel?.track).toHaveBeenCalledTimes(2));
    expect(channel?.untrack).not.toHaveBeenCalled();
    expect(channel?.track.mock.calls.at(-1)?.[0]).toMatchObject({
      viewingSessionId: null,
    });
  });

  it("queues broadcasts sent while the private channel is reconnecting", async () => {
    const conn = createOrg2CloudRealtimeConnection(async () => "token-abc");
    const handle = conn.joinPresence({
      scope: "org:org-123",
      key: "user-9",
      payload: null,
      onSync: () => undefined,
    });
    const channel = createdChannels.at(-1);

    handle.send("comments-changed", { sessionId: "session-1" });
    expect(channel?.send).not.toHaveBeenCalled();

    await flushJoins();
    channel?.emitStatus("SUBSCRIBED");
    await vi.waitFor(() => expect(channel?.send).toHaveBeenCalledTimes(1));
    expect(channel?.send).toHaveBeenCalledWith({
      type: "broadcast",
      event: "comments-changed",
      payload: { sessionId: "session-1" },
    });
  });

  it("retries a broadcast transport failure without losing its nudge", async () => {
    vi.useFakeTimers();
    const conn = createOrg2CloudRealtimeConnection(async () => "token-abc");
    const handle = conn.joinPresence({
      scope: "org:org-123",
      key: "user-9",
      payload: null,
      onSync: () => undefined,
    });
    const channel = createdChannels.at(-1);
    channel?.send.mockResolvedValueOnce("timed out");
    await flushJoins();
    channel?.emitStatus("SUBSCRIBED");

    handle.send("comments-changed", { sessionId: "session-1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(channel?.send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel?.send).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("backs off persistently failing broadcasts instead of retrying at 1 Hz", async () => {
    vi.useFakeTimers();
    const conn = createOrg2CloudRealtimeConnection(async () => "token-abc");
    const handle = conn.joinPresence({
      scope: "org:org-123",
      key: "user-9",
      payload: null,
      onSync: () => undefined,
    });
    const channel = createdChannels.at(-1);
    channel?.send.mockResolvedValue("timed out");
    await flushJoins();
    channel?.emitStatus("SUBSCRIBED");

    handle.send("comments-changed", { sessionId: "session-1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(channel?.send).toHaveBeenCalledTimes(1);

    // Retry #1 fires at the 1s base delay …
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel?.send).toHaveBeenCalledTimes(2);
    // … retry #2 doubles to 2s …
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel?.send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel?.send).toHaveBeenCalledTimes(3);
    // … retry #3 doubles again to 4s.
    await vi.advanceTimersByTimeAsync(3_999);
    expect(channel?.send).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(channel?.send).toHaveBeenCalledTimes(4);

    // A persistent failure settles at the 30s ceiling, never beyond it.
    for (let index = 0; index < 10; index += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    const settledCalls = channel?.send.mock.calls.length ?? 0;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(channel?.send.mock.calls.length).toBe(settledCalls + 1);
    vi.useRealTimers();
  });

  it("resets the broadcast backoff once a send succeeds", async () => {
    vi.useFakeTimers();
    const conn = createOrg2CloudRealtimeConnection(async () => "token-abc");
    const handle = conn.joinPresence({
      scope: "org:org-123",
      key: "user-9",
      payload: null,
      onSync: () => undefined,
    });
    const channel = createdChannels.at(-1);
    channel?.send
      .mockResolvedValueOnce("timed out")
      .mockResolvedValueOnce("timed out")
      .mockResolvedValueOnce("ok");
    await flushJoins();
    channel?.emitStatus("SUBSCRIBED");

    handle.send("comments-changed", { sessionId: "session-1" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000); // retry #1 (fails)
    await vi.advanceTimersByTimeAsync(2_000); // retry #2 (succeeds)
    expect(channel?.send).toHaveBeenCalledTimes(3);

    // The streak reset means a NEW failure retries at the base delay again.
    channel?.send.mockResolvedValueOnce("timed out");
    handle.send("comments-changed", { sessionId: "session-2" });
    await vi.advanceTimersByTimeAsync(0);
    expect(channel?.send).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel?.send).toHaveBeenCalledTimes(5);
    vi.useRealTimers();
  });

  it("backs off persistently failing presence tracks instead of retrying at 1 Hz", async () => {
    vi.useFakeTimers();
    const conn = createOrg2CloudRealtimeConnection(async () => "token-abc");
    conn.joinPresence({
      scope: "org:org-123",
      key: "user-9",
      payload: { viewingSessionId: "session-1" },
      onSync: () => undefined,
    });
    const channel = createdChannels.at(-1);
    channel?.track.mockResolvedValue("timed out");
    await flushJoins();
    channel?.emitStatus("SUBSCRIBED");

    await vi.advanceTimersByTimeAsync(0);
    expect(channel?.track).toHaveBeenCalledTimes(1);
    // Retry #1 at the 1s base delay, retry #2 doubled to 2s.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel?.track).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel?.track).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel?.track).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("does not let a timed-out track block a newer presence payload", async () => {
    const conn = createOrg2CloudRealtimeConnection(async () => "token-abc");
    const handle = conn.joinPresence({
      scope: "org:org-123",
      key: "user-9",
      payload: { viewingSessionId: null, updatedAt: 1 },
      onSync: () => undefined,
    });
    const channel = createdChannels.at(-1);
    channel?.track.mockResolvedValueOnce("timed out");

    await flushJoins();
    channel?.emitStatus("SUBSCRIBED");
    handle.update({ viewingSessionId: "session-1", updatedAt: 2 });

    await vi.waitFor(() => expect(channel?.track).toHaveBeenCalledTimes(2));
    expect(channel?.track.mock.calls.at(-1)?.[0]).toEqual({
      viewingSessionId: "session-1",
      updatedAt: 2,
    });
  });

  it("shares the five-call rolling Presence budget across org channels", async () => {
    vi.useFakeTimers();
    const conn = createOrg2CloudRealtimeConnection(async () => "token-abc");
    for (let index = 0; index < 6; index += 1) {
      conn.joinPresence({
        scope: `org:org-${index}`,
        key: "user-9",
        payload: { viewingSessionId: `session-${index}` },
        onSync: () => undefined,
      });
    }
    const sixChannels = createdChannels.slice(-6);
    await flushJoins();
    for (const channel of sixChannels) channel.emitStatus("SUBSCRIBED");

    await vi.advanceTimersByTimeAsync(0);
    expect(
      sixChannels.reduce(
        (total, channel) => total + channel.track.mock.calls.length,
        0
      )
    ).toBe(5);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(
      sixChannels.reduce(
        (total, channel) => total + channel.track.mock.calls.length,
        0
      )
    ).toBe(5);

    await vi.advanceTimersByTimeAsync(200);
    expect(
      sixChannels.reduce(
        (total, channel) => total + channel.track.mock.calls.length,
        0
      )
    ).toBe(6);
    vi.useRealTimers();
  });
});
