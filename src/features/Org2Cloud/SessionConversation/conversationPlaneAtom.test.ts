import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "../org2CloudAuthAtom";
import type { CloudConversationEvent } from "../org2CloudConversationEventsClient";
import {
  boundConversationPlaneWindow,
  conversationPlaneAtom,
  conversationPlaneKey,
  loadCompleteConversationPlaneEvents,
  refreshConversationPlaneEntry,
} from "./conversationPlaneAtom";

const mocks = vi.hoisted(() => ({
  ensureFreshSession: vi.fn(),
  getCloudCapabilitiesConfirmed: vi.fn(),
  listConversationEvents: vi.fn(),
}));

vi.mock("../org2CloudClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../org2CloudClient")>()),
  ensureFreshSession: mocks.ensureFreshSession,
}));

vi.mock("../org2CloudCapabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../org2CloudCapabilities")>()),
  getCloudCapabilitiesConfirmed: mocks.getCloudCapabilitiesConfirmed,
}));

vi.mock("../org2CloudConversationEventsClient", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../org2CloudConversationEventsClient")
  >()),
  listConversationEvents: mocks.listConversationEvents,
}));

function row(seq: number, text = `event-${seq}`): CloudConversationEvent {
  const event = {
    id: `event-${seq}`,
    chunk_id: `event-${seq}`,
    sessionId: "root",
    createdAt: `2026-08-20T10:00:${String(seq).padStart(2, "0")}Z`,
    functionName: "assistant_message",
    uiCanonical: "assistant_message",
    actionType: "assistant",
    args: {},
    result: { observation: text },
    source: "assistant",
    displayText: text,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    payloadRefs: [],
  } as SessionEvent;
  return {
    id: `row-${seq}`,
    rootSessionId: "root",
    authorUserId: "alice",
    turnId: `turn-${seq}`,
    seq,
    event,
    createdAt: event.createdAt,
  };
}

const AUTH = {
  kind: "org2_cloud" as const,
  supabaseUrl: "https://cloud.invalid",
  supabaseAnonKey: "anon",
  userId: "alice",
  accessToken: "token",
  refreshToken: "refresh",
  expiresAt: 4_102_444_800,
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("conversation plane render window", () => {
  it("retains only the bounded visible tail and exposes the durable gap", () => {
    const window = boundConversationPlaneWindow([row(1), row(2), row(3)], {
      maxEvents: 2,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(window.events.map((event) => event.seq)).toEqual([2, 3]);
    expect(window.firstSeq).toBe(2);
    expect(window.hasEarlierEvents).toBe(true);
  });

  it("does not retain a single event beyond the entry byte ceiling", () => {
    const window = boundConversationPlaneWindow([row(1, "large")], {
      maxEvents: 10,
      maxBytes: 1,
    });

    expect(window.events).toEqual([]);
    expect(window.approximateBytes).toBe(0);
    expect(window.firstSeq).toBeNull();
    expect(window.hasEarlierEvents).toBe(true);
  });
});

describe("complete conversation plane pull", () => {
  const ENDPOINT = { supabaseUrl: "https://cloud.invalid", anonKey: "anon" };

  beforeEach(() => {
    mocks.listConversationEvents.mockReset();
  });

  it("follows the wire cursor across a fully quarantined page", async () => {
    mocks.listConversationEvents
      .mockResolvedValueOnce({
        events: [],
        hasMore: true,
        lastSeq: 4,
        quarantined: 2,
      })
      .mockResolvedValueOnce({
        events: [row(5)],
        hasMore: false,
        lastSeq: 5,
        quarantined: 0,
      });

    const events = await loadCompleteConversationPlaneEvents(
      "token",
      { orgId: "org-1", rootSessionId: "root" },
      ENDPOINT
    );

    expect(events.map((event) => event.seq)).toEqual([5]);
    expect(
      mocks.listConversationEvents.mock.calls.map(
        (call) => (call[1] as { afterSeq: number }).afterSeq
      )
    ).toEqual([0, 4]);
  });

  it("stops when the wire cursor cannot advance", async () => {
    mocks.listConversationEvents.mockResolvedValue({
      events: [],
      hasMore: true,
      lastSeq: 0,
      quarantined: 0,
    });

    await expect(
      loadCompleteConversationPlaneEvents(
        "token",
        { orgId: "org-1", rootSessionId: "root" },
        ENDPOINT
      )
    ).resolves.toEqual([]);
    expect(mocks.listConversationEvents).toHaveBeenCalledTimes(1);
  });
});

describe("conversation plane singleflight", () => {
  beforeEach(() => {
    mocks.ensureFreshSession.mockReset();
    mocks.ensureFreshSession.mockResolvedValue(AUTH);
    mocks.getCloudCapabilitiesConfirmed.mockReset();
    mocks.getCloudCapabilitiesConfirmed.mockResolvedValue({
      confirmed: true,
      capabilities: { conversationEvents: true },
    });
    mocks.listConversationEvents.mockReset();
  });

  function harness() {
    const store = createStore();
    store.set(org2CloudAuthAtom, AUTH);
    const locator = {
      authIdentityKey: org2CloudAuthIdentityKey(AUTH),
      orgId: "org-1",
      rootSessionId: "root",
    };
    const key = conversationPlaneKey(locator);
    const refresh = (invalidationKey?: string) =>
      refreshConversationPlaneEntry({
        store,
        auth: AUTH,
        orgId: locator.orgId,
        rootSessionId: locator.rootSessionId,
        getEntry: () => store.get(conversationPlaneAtom)[key],
        setEntries: (update) => store.set(conversationPlaneAtom, update),
        setAuth: (update) => store.set(org2CloudAuthAtom, update),
        ...(invalidationKey ? { invalidationKey } : {}),
      });
    return { refresh };
  }

  it("lets ordinary readers join without manufacturing a trailing pull", async () => {
    const page = deferred<{
      events: CloudConversationEvent[];
      hasMore: boolean;
      lastSeq: number;
      quarantined: number;
    }>();
    mocks.listConversationEvents.mockReturnValue(page.promise);
    const { refresh } = harness();

    const first = refresh();
    const joined = refresh();

    expect(joined).toBe(first);
    await vi.waitFor(() => {
      expect(mocks.listConversationEvents).toHaveBeenCalledTimes(1);
    });
    page.resolve({
      events: [row(1)],
      hasMore: false,
      lastSeq: 1,
      quarantined: 0,
    });
    await Promise.all([first, joined]);
    expect(mocks.listConversationEvents).toHaveBeenCalledTimes(1);
  });

  it("runs one trailing pull only for a newer invalidation", async () => {
    const firstPage = deferred<{
      events: CloudConversationEvent[];
      hasMore: boolean;
      lastSeq: number;
      quarantined: number;
    }>();
    mocks.listConversationEvents
      .mockReturnValueOnce(firstPage.promise)
      .mockResolvedValueOnce({
        events: [],
        hasMore: false,
        lastSeq: 1,
        quarantined: 0,
      });
    const { refresh } = harness();

    const first = refresh("signal:1");
    const sameSignal = refresh("signal:1");
    const newerSignal = refresh("signal:2");

    expect(sameSignal).toBe(first);
    expect(newerSignal).not.toBe(first);
    await vi.waitFor(() => {
      expect(mocks.listConversationEvents).toHaveBeenCalledTimes(1);
    });
    firstPage.resolve({
      events: [row(1)],
      hasMore: false,
      lastSeq: 1,
      quarantined: 0,
    });
    await Promise.all([first, sameSignal, newerSignal]);

    expect(mocks.listConversationEvents).toHaveBeenCalledTimes(2);
    expect(
      mocks.listConversationEvents.mock.calls.map(
        ([, params]) => params.afterSeq
      )
    ).toEqual([0, 1]);
  });

  it("still services a newer invalidation after the joined request fails", async () => {
    const firstPage = deferred<{
      events: CloudConversationEvent[];
      hasMore: boolean;
      lastSeq: number;
      quarantined: number;
    }>();
    mocks.listConversationEvents
      .mockReturnValueOnce(firstPage.promise)
      .mockResolvedValueOnce({
        events: [row(1)],
        hasMore: false,
        lastSeq: 1,
        quarantined: 0,
      });
    const { refresh } = harness();

    const first = refresh("signal:1");
    const firstOutcome = first.then(
      () => "resolved",
      () => "rejected"
    );
    const newerSignal = refresh("signal:2");
    await vi.waitFor(() => {
      expect(mocks.listConversationEvents).toHaveBeenCalledTimes(1);
    });
    firstPage.reject(new Error("network failed"));

    await expect(newerSignal).resolves.toMatchObject({
      state: "ready",
      lastSeq: 1,
    });
    await expect(firstOutcome).resolves.toBe("rejected");
    expect(mocks.listConversationEvents).toHaveBeenCalledTimes(2);
  });
});
