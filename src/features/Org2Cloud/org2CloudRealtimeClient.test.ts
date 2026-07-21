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

  it("opens the presence/broadcast channel as private with the presence key", () => {
    const conn = createOrg2CloudRealtimeConnection("token-abc");
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

  it("authorizes the socket with the access token before joining (RLS private-channel requirement)", () => {
    createOrg2CloudRealtimeConnection("token-abc");
    expect(setAuthMock).toHaveBeenCalledWith("token-abc");
  });

  it("re-authorizes the live socket when the token is refreshed", () => {
    const conn = createOrg2CloudRealtimeConnection("token-abc");
    setAuthMock.mockClear();
    conn.setAuth("token-def");
    expect(setAuthMock).toHaveBeenCalledWith("token-def");
  });

  it("leaves table-change channels public (postgres_changes are gated by table RLS, not realtime.messages)", () => {
    const conn = createOrg2CloudRealtimeConnection("token-abc");
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

  it("uses a fresh topic for a fast same-filter resubscribe", () => {
    const conn = createOrg2CloudRealtimeConnection("token-abc");
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
    const conn = createOrg2CloudRealtimeConnection("token-abc");
    const handle = conn.joinPresence({
      scope: "org:org-123",
      key: "user-9",
      payload: { viewingSessionId: null, updatedAt: 1 },
      onSync: () => undefined,
    });
    const channel = createdChannels.at(-1);
    expect(channel).toBeDefined();
    channel?.track.mockImplementationOnce(() => initialTrack);

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

  it("does not track inactive orgs and untracks only after a published view", async () => {
    const conn = createOrg2CloudRealtimeConnection("token-abc");
    const handle = conn.joinPresence({
      scope: "org:org-123",
      key: "user-9",
      payload: null,
      onSync: () => undefined,
    });
    const channel = createdChannels.at(-1);

    channel?.emitStatus("SUBSCRIBED");
    await Promise.resolve();
    expect(channel?.track).not.toHaveBeenCalled();
    expect(channel?.untrack).not.toHaveBeenCalled();

    handle.update({ viewingSessionId: "session-1", updatedAt: 2 });
    await vi.waitFor(() => expect(channel?.track).toHaveBeenCalledTimes(1));

    handle.update(null);
    await vi.waitFor(() => expect(channel?.untrack).toHaveBeenCalledTimes(1));
  });

  it("queues broadcasts sent while the private channel is reconnecting", async () => {
    const conn = createOrg2CloudRealtimeConnection("token-abc");
    const handle = conn.joinPresence({
      scope: "org:org-123",
      key: "user-9",
      payload: null,
      onSync: () => undefined,
    });
    const channel = createdChannels.at(-1);

    handle.send("comments-changed", { sessionId: "session-1" });
    expect(channel?.send).not.toHaveBeenCalled();

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
    const conn = createOrg2CloudRealtimeConnection("token-abc");
    const handle = conn.joinPresence({
      scope: "org:org-123",
      key: "user-9",
      payload: null,
      onSync: () => undefined,
    });
    const channel = createdChannels.at(-1);
    channel?.send.mockResolvedValueOnce("timed out");
    channel?.emitStatus("SUBSCRIBED");

    handle.send("comments-changed", { sessionId: "session-1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(channel?.send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel?.send).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not let a timed-out track block a newer presence payload", async () => {
    const conn = createOrg2CloudRealtimeConnection("token-abc");
    const handle = conn.joinPresence({
      scope: "org:org-123",
      key: "user-9",
      payload: { viewingSessionId: null, updatedAt: 1 },
      onSync: () => undefined,
    });
    const channel = createdChannels.at(-1);
    channel?.track.mockResolvedValueOnce("timed out");

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
    const conn = createOrg2CloudRealtimeConnection("token-abc");
    for (let index = 0; index < 6; index += 1) {
      conn.joinPresence({
        scope: `org:org-${index}`,
        key: "user-9",
        payload: { viewingSessionId: `session-${index}` },
        onSync: () => undefined,
      });
    }
    const sixChannels = createdChannels.slice(-6);
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
