import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __CAPABILITIES_INTERNALS,
  getCloudCapabilities,
  getCloudCapabilitiesConfirmed,
} from "./org2CloudCapabilities";
import { getCloudCapabilitiesRaw } from "./org2CloudClient";

vi.mock("./org2CloudClient", () => ({
  getCloudCapabilitiesRaw: vi.fn(),
}));

const rawMock = vi.mocked(getCloudCapabilitiesRaw);

beforeEach(() => {
  __CAPABILITIES_INTERNALS.reset();
});

afterEach(() => {
  rawMock.mockReset();
});

describe("getCloudCapabilities", () => {
  it("parses a 0005 payload and caches it per endpoint", async () => {
    rawMock.mockResolvedValueOnce({ broadcastSignals: true });
    expect(await getCloudCapabilities("jwt-1")).toEqual({
      broadcastSignals: true,
      storageSegments: false,
      homeEndpoints: false,
      teamInboxMentions: false,
      memberRuntime: false,
      sessionTurnIndex: false,
      offlineSync: false,
      orgChannels: false,
      orgChannelMessages: false,
      orgChannelMessagesIdempotency: false,
      conversationEvents: false,
    });
    expect(await getCloudCapabilities("jwt-1")).toEqual({
      broadcastSignals: true,
      storageSegments: false,
      homeEndpoints: false,
      teamInboxMentions: false,
      memberRuntime: false,
      sessionTurnIndex: false,
      offlineSync: false,
      orgChannels: false,
      orgChannelMessages: false,
      orgChannelMessagesIdempotency: false,
      conversationEvents: false,
    });
    expect(rawMock).toHaveBeenCalledTimes(1);
  });

  it("parses the 0006 storageSegments flag", async () => {
    rawMock.mockResolvedValueOnce({
      broadcastSignals: true,
      storageSegments: true,
    });
    expect(await getCloudCapabilities("jwt-1")).toEqual({
      broadcastSignals: true,
      storageSegments: true,
      homeEndpoints: false,
      teamInboxMentions: false,
      memberRuntime: false,
      sessionTurnIndex: false,
      offlineSync: false,
      orgChannels: false,
      orgChannelMessages: false,
      orgChannelMessagesIdempotency: false,
      conversationEvents: false,
    });
  });

  it("carries the 0016 idempotency flag through the wire rebuild", async () => {
    // Regression guard for the flag-stripping trap this layer creates: the
    // probe REBUILDS the object from enumerated fields, so a new wire flag a
    // consumer reads structurally is silently dropped until it is modeled
    // here. The 0016 rollout shipped exactly that bug — posts never keyed —
    // and only the live dual-instance pass caught it.
    rawMock.mockResolvedValueOnce({
      orgChannels: true,
      orgChannelMessages: true,
      orgChannelMessagesIdempotency: true,
      conversationEvents: false,
    });
    const capabilities = await getCloudCapabilities("jwt-1");
    expect(capabilities.orgChannelMessagesIdempotency).toBe(true);
  });

  it("parses the 0007 homeEndpoints flag", async () => {
    rawMock.mockResolvedValueOnce({
      broadcastSignals: true,
      storageSegments: true,
      homeEndpoints: true,
    });
    expect(await getCloudCapabilities("jwt-1")).toEqual({
      broadcastSignals: true,
      storageSegments: true,
      homeEndpoints: true,
      teamInboxMentions: false,
      memberRuntime: false,
      sessionTurnIndex: false,
      offlineSync: false,
      orgChannels: false,
      orgChannelMessages: false,
      orgChannelMessagesIdempotency: false,
      conversationEvents: false,
    });
  });

  it("parses the 0010 Team Inbox mention capability", async () => {
    rawMock.mockResolvedValueOnce({
      broadcastSignals: true,
      storageSegments: true,
      homeEndpoints: true,
      teamInboxMentions: true,
    });
    expect(await getCloudCapabilities("jwt-1")).toEqual({
      broadcastSignals: true,
      storageSegments: true,
      homeEndpoints: true,
      teamInboxMentions: true,
      memberRuntime: false,
      sessionTurnIndex: false,
      offlineSync: false,
      orgChannels: false,
      orgChannelMessages: false,
      orgChannelMessagesIdempotency: false,
      conversationEvents: false,
    });
  });

  it("parses the 0010 member-runtime capability", async () => {
    rawMock.mockResolvedValueOnce({
      broadcastSignals: true,
      storageSegments: true,
      homeEndpoints: true,
      teamInboxMentions: true,
      memberRuntime: true,
      sessionTurnIndex: false,
      offlineSync: false,
      orgChannels: false,
      orgChannelMessages: false,
      orgChannelMessagesIdempotency: false,
      conversationEvents: false,
    });
    expect(await getCloudCapabilities("jwt-1")).toEqual({
      broadcastSignals: true,
      storageSegments: true,
      homeEndpoints: true,
      teamInboxMentions: true,
      memberRuntime: true,
      sessionTurnIndex: false,
      offlineSync: false,
      orgChannels: false,
      orgChannelMessages: false,
      orgChannelMessagesIdempotency: false,
      conversationEvents: false,
    });
  });

  it("answers legacy on failure without caching so the next probe retries", async () => {
    rawMock.mockResolvedValueOnce(null);
    expect(await getCloudCapabilities("jwt-1")).toEqual({
      broadcastSignals: false,
      storageSegments: false,
      homeEndpoints: false,
      teamInboxMentions: false,
      memberRuntime: false,
      sessionTurnIndex: false,
      offlineSync: false,
      orgChannels: false,
      orgChannelMessages: false,
      orgChannelMessagesIdempotency: false,
      conversationEvents: false,
    });
    rawMock.mockResolvedValueOnce({ broadcastSignals: true });
    expect(await getCloudCapabilities("jwt-1")).toEqual({
      broadcastSignals: true,
      storageSegments: false,
      homeEndpoints: false,
      teamInboxMentions: false,
      memberRuntime: false,
      sessionTurnIndex: false,
      offlineSync: false,
      orgChannels: false,
      orgChannelMessages: false,
      orgChannelMessagesIdempotency: false,
      conversationEvents: false,
    });
    expect(rawMock).toHaveBeenCalledTimes(2);
  });

  it("degrades a malformed flag to false and still caches the answer", async () => {
    rawMock.mockResolvedValueOnce({
      broadcastSignals: "yes",
      storageSegments: "yes",
      homeEndpoints: "yes",
    });
    expect(await getCloudCapabilities("jwt-1")).toEqual({
      broadcastSignals: false,
      storageSegments: false,
      homeEndpoints: false,
      teamInboxMentions: false,
      memberRuntime: false,
      sessionTurnIndex: false,
      offlineSync: false,
      orgChannels: false,
      orgChannelMessages: false,
      orgChannelMessagesIdempotency: false,
      conversationEvents: false,
    });
    expect(await getCloudCapabilities("jwt-1")).toEqual({
      broadcastSignals: false,
      storageSegments: false,
      homeEndpoints: false,
      teamInboxMentions: false,
      memberRuntime: false,
      sessionTurnIndex: false,
      offlineSync: false,
      orgChannels: false,
      orgChannelMessages: false,
      orgChannelMessagesIdempotency: false,
      conversationEvents: false,
    });
    expect(rawMock).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent probes into one request", async () => {
    let release: (value: unknown) => void = () => undefined;
    rawMock.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const first = getCloudCapabilities("jwt-1");
    const second = getCloudCapabilities("jwt-1");
    release({ broadcastSignals: true, storageSegments: true });
    expect(await first).toEqual({
      broadcastSignals: true,
      storageSegments: true,
      homeEndpoints: false,
      teamInboxMentions: false,
      memberRuntime: false,
      sessionTurnIndex: false,
      offlineSync: false,
      orgChannels: false,
      orgChannelMessages: false,
      orgChannelMessagesIdempotency: false,
      conversationEvents: false,
    });
    expect(await second).toEqual({
      broadcastSignals: true,
      storageSegments: true,
      homeEndpoints: false,
      teamInboxMentions: false,
      memberRuntime: false,
      sessionTurnIndex: false,
      offlineSync: false,
      orgChannels: false,
      orgChannelMessages: false,
      orgChannelMessagesIdempotency: false,
      conversationEvents: false,
    });
    expect(rawMock).toHaveBeenCalledTimes(1);
  });
});

describe("getCloudCapabilitiesConfirmed", () => {
  it("confirms a valid response even when it's the legacy (all-false) shape", async () => {
    rawMock.mockResolvedValueOnce({});
    const result = await getCloudCapabilitiesConfirmed("jwt-1");
    expect(result.confirmed).toBe(true);
    expect(result.capabilities).toEqual({
      broadcastSignals: false,
      storageSegments: false,
      homeEndpoints: false,
      teamInboxMentions: false,
      memberRuntime: false,
      sessionTurnIndex: false,
      offlineSync: false,
      orgChannels: false,
      orgChannelMessages: false,
      orgChannelMessagesIdempotency: false,
      conversationEvents: false,
    });
  });

  it("confirms and reports the memberRuntime flag on a full 0010 response", async () => {
    rawMock.mockResolvedValueOnce({
      broadcastSignals: true,
      storageSegments: true,
      homeEndpoints: true,
      teamInboxMentions: true,
      memberRuntime: true,
      sessionTurnIndex: false,
      offlineSync: false,
      orgChannels: false,
      orgChannelMessages: false,
      orgChannelMessagesIdempotency: false,
      conversationEvents: false,
    });
    const result = await getCloudCapabilitiesConfirmed("jwt-1");
    expect(result.confirmed).toBe(true);
    expect(result.capabilities.memberRuntime).toBe(true);
  });

  it("does NOT confirm a null response (pre-0005 404 or a swallowed transport failure)", async () => {
    rawMock.mockResolvedValueOnce(null);
    const result = await getCloudCapabilitiesConfirmed("jwt-1");
    expect(result.confirmed).toBe(false);
    expect(result.capabilities).toEqual({
      broadcastSignals: false,
      storageSegments: false,
      homeEndpoints: false,
      teamInboxMentions: false,
      memberRuntime: false,
      sessionTurnIndex: false,
      offlineSync: false,
      orgChannels: false,
      orgChannelMessages: false,
      orgChannelMessagesIdempotency: false,
      conversationEvents: false,
    });
  });

  it("does NOT confirm when the probe itself throws (e.g. a hard timeout)", async () => {
    rawMock.mockRejectedValueOnce(new Error("timed out"));
    const result = await getCloudCapabilitiesConfirmed("jwt-1");
    expect(result.confirmed).toBe(false);
    expect(result.capabilities.memberRuntime).toBe(false);
  });

  it("does not cache an unconfirmed read: the next probe retries", async () => {
    rawMock.mockRejectedValueOnce(new Error("timed out"));
    await getCloudCapabilitiesConfirmed("jwt-1");
    rawMock.mockResolvedValueOnce({ memberRuntime: true });
    const result = await getCloudCapabilitiesConfirmed("jwt-1");
    expect(result.confirmed).toBe(true);
    expect(result.capabilities.memberRuntime).toBe(true);
    expect(rawMock).toHaveBeenCalledTimes(2);
  });

  it("shares the same per-endpoint cache as getCloudCapabilities", async () => {
    rawMock.mockResolvedValueOnce({ broadcastSignals: true });
    expect(await getCloudCapabilities("jwt-1")).toEqual({
      broadcastSignals: true,
      storageSegments: false,
      homeEndpoints: false,
      teamInboxMentions: false,
      memberRuntime: false,
      sessionTurnIndex: false,
      offlineSync: false,
      orgChannels: false,
      orgChannelMessages: false,
      orgChannelMessagesIdempotency: false,
      conversationEvents: false,
    });
    // A cached hit is, by definition, a confirmed read — no second RPC.
    const result = await getCloudCapabilitiesConfirmed("jwt-1");
    expect(result.confirmed).toBe(true);
    expect(result.capabilities.broadcastSignals).toBe(true);
    expect(rawMock).toHaveBeenCalledTimes(1);
  });
});
