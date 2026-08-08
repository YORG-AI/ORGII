// @vitest-environment jsdom
//
// Probe-component harness (`useOrgChannels.test.ts`): the hook's state is
// rendered into data attributes, so assertions read the surface's own view of
// it. The write path additionally needs to be CALLED, so the probe publishes
// the live state object into a test-owned ref — the same handle the panel gets
// from the hook — which is what lets a refused post be awaited and asserted on.
import { Provider, createStore } from "jotai";
import { act, createElement, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { org2CloudAuthAtom } from "../org2CloudAuthAtom";
import { endpointForOrg } from "../org2CloudOrgEndpointRouter";
import { Org2CloudChannelMessagesError } from "./channelMessagesClient";
import type {
  CloudChannelMessage,
  CloudChannelMessagesPage,
} from "./channelMessagesTypes";
import { bumpOrg2CloudChannelMessagesVersionAtom } from "./channelsAtom";
import {
  type CloudChannelMessagesState,
  useCloudChannelMessages,
} from "./useCloudChannelMessages";

const mocks = vi.hoisted(() => ({
  ensureFreshSession: vi.fn(),
  getCloudCapabilities: vi.fn(),
  listCloudChannelMessages: vi.fn(),
  postCloudChannelMessage: vi.fn(),
  editCloudChannelMessage: vi.fn(),
  deleteCloudChannelMessage: vi.fn(),
  setCloudChannelReadCursor: vi.fn(),
}));

vi.mock("../org2CloudClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../org2CloudClient")>();
  return { ...actual, ensureFreshSession: mocks.ensureFreshSession };
});

vi.mock("../org2CloudCapabilities", () => ({
  getCloudCapabilities: mocks.getCloudCapabilities,
}));

// The error CLASS stays real — the hook rethrows it and callers map by code.
vi.mock("./channelMessagesClient", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./channelMessagesClient")>();
  return {
    ...actual,
    listCloudChannelMessages: mocks.listCloudChannelMessages,
    postCloudChannelMessage: mocks.postCloudChannelMessage,
    editCloudChannelMessage: mocks.editCloudChannelMessage,
    deleteCloudChannelMessage: mocks.deleteCloudChannelMessage,
    setCloudChannelReadCursor: mocks.setCloudChannelReadCursor,
  };
});

const AUTH = {
  kind: "org2_cloud" as const,
  supabaseUrl: "https://cloud.example.test",
  supabaseAnonKey: "anon",
  userId: "user-a",
  accessToken: "stale",
  refreshToken: "refresh",
  expiresAt: 4_102_444_800,
};

function makeMessage(
  overrides: Partial<CloudChannelMessage> & { id: string }
): CloudChannelMessage {
  const createdAt = overrides.createdAt ?? "2026-07-31T00:00:00.000Z";
  return {
    channelId: "chan-1",
    authorUserId: "user-a",
    authorDisplayName: "Ada",
    authorAvatarUrl: undefined,
    body: "hello",
    createdAt,
    editedAt: null,
    deletedAt: null,
    stateChangedAt: createdAt,
    mentionedUserIds: [],
    ...overrides,
  };
}

function page(
  messages: CloudChannelMessage[],
  overrides: Partial<CloudChannelMessagesPage> = {}
): CloudChannelMessagesPage {
  return {
    messages,
    nextCursor: null,
    unreadCount: 0,
    serverTime: "2026-07-31T12:00:00.000Z",
    hasMore: false,
    ...overrides,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

interface ProbeProps {
  orgId: string | null;
  channelId: string | null;
  stateRef: { current: CloudChannelMessagesState | null };
}

function Probe({ orgId, channelId, stateRef }: ProbeProps) {
  const state = useCloudChannelMessages(orgId, channelId, {
    readCursorDebounceMs: 0,
  });
  // Published from an effect, never during render: the panel gets the same
  // object, and the test drives the write path through it.
  useEffect(() => {
    stateRef.current = state;
  }, [state, stateRef]);
  return createElement("div", {
    "data-testid": "messages-probe",
    "data-phase": state.phase,
    "data-error": state.error ?? "",
    "data-unread": String(state.unreadCount),
    "data-has-older": String(state.hasOlder),
    "data-bodies": state.messages.map((message) => message.body).join(","),
    "data-ids": state.messages.map((message) => message.id).join(","),
    "data-tombstones": state.messages
      .filter((message) => message.deletedAt !== null)
      .map((message) => message.id)
      .join(","),
  });
}

describe("useCloudChannelMessages", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;
  let stateRef: { current: CloudChannelMessagesState | null };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.ensureFreshSession.mockImplementation(async (state: typeof AUTH) => ({
      ...state,
      accessToken: "fresh-token",
    }));
    mocks.getCloudCapabilities.mockResolvedValue({ orgChannelMessages: true });
    mocks.setCloudChannelReadCursor.mockResolvedValue({
      lastReadAt: "2026-07-31T00:00:00.000Z",
      unreadCount: 0,
    });
    stateRef = { current: null };
    store = createStore();
    store.set(org2CloudAuthAtom, AUTH);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function renderProbe(orgId: string | null, channelId: string | null) {
    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(Probe, { orgId, channelId, stateRef })
        )
      );
    });
  }

  function probe(): DOMStringMap {
    const element = document.querySelector<HTMLElement>(
      '[data-testid="messages-probe"]'
    );
    expect(element).not.toBeNull();
    return (element as HTMLElement).dataset;
  }

  function state(): CloudChannelMessagesState {
    const current = stateRef.current;
    if (!current) throw new Error("probe never rendered");
    return current;
  }

  it("resolves unsupported from the capability probe and never calls a message RPC", async () => {
    mocks.getCloudCapabilities.mockResolvedValue({
      orgChannelMessages: false,
    });
    renderProbe("org-a", "chan-1");
    await flushAsync();

    expect(probe().phase).toBe("unsupported");
    expect(mocks.listCloudChannelMessages).not.toHaveBeenCalled();
    expect(mocks.setCloudChannelReadCursor).not.toHaveBeenCalled();
    // Probed against the ORG's endpoint, not the default one — a home-endpoint
    // org answers for its own backend.
    expect(mocks.getCloudCapabilities).toHaveBeenCalledWith(
      "fresh-token",
      endpointForOrg("org-a")
    );
  });

  it("reverses the descending page into transcript order", async () => {
    // The RPC answers newest-first (DESC keyset); the transcript is ascending.
    mocks.listCloudChannelMessages.mockResolvedValue(
      page(
        [
          makeMessage({
            id: "m3",
            body: "third",
            createdAt: "2026-07-31T03:00:00.000Z",
          }),
          makeMessage({
            id: "m2",
            body: "second",
            createdAt: "2026-07-31T02:00:00.000Z",
          }),
          makeMessage({
            id: "m1",
            body: "first",
            createdAt: "2026-07-31T01:00:00.000Z",
          }),
        ],
        {
          unreadCount: 2,
          nextCursor: "2026-07-31T01:00:00.000Z|m1",
        }
      )
    );
    renderProbe("org-a", "chan-1");
    await flushAsync();

    expect(probe().phase).toBe("ready");
    expect(probe().bodies).toBe("first,second,third");
    expect(probe().hasOlder).toBe("true");
    expect(mocks.listCloudChannelMessages).toHaveBeenCalledWith(
      "fresh-token",
      "org-a",
      "chan-1",
      { limit: 50 }
    );
  });

  it("applies an edit and a tombstone from the delta to already-loaded rows", async () => {
    mocks.listCloudChannelMessages.mockResolvedValueOnce(
      page([
        makeMessage({
          id: "m2",
          body: "typo here",
          createdAt: "2026-07-31T02:00:00.000Z",
        }),
        makeMessage({
          id: "m1",
          body: "keep me",
          createdAt: "2026-07-31T01:00:00.000Z",
        }),
      ])
    );
    renderProbe("org-a", "chan-1");
    await flushAsync();
    expect(probe().bodies).toBe("keep me,typo here");

    // Delta mode: ascending rows newer than `serverTime`, carrying an EDIT of
    // a loaded row, a TOMBSTONE of another, and one brand-new message.
    mocks.listCloudChannelMessages.mockResolvedValueOnce(
      page(
        [
          makeMessage({
            id: "m1",
            body: "",
            createdAt: "2026-07-31T01:00:00.000Z",
            deletedAt: "2026-07-31T13:00:00.000Z",
            stateChangedAt: "2026-07-31T13:00:00.000Z",
          }),
          makeMessage({
            id: "m2",
            body: "typo fixed",
            createdAt: "2026-07-31T02:00:00.000Z",
            editedAt: "2026-07-31T13:01:00.000Z",
            stateChangedAt: "2026-07-31T13:01:00.000Z",
          }),
          makeMessage({
            id: "m3",
            body: "brand new",
            createdAt: "2026-07-31T03:00:00.000Z",
            stateChangedAt: "2026-07-31T03:00:00.000Z",
          }),
        ],
        { unreadCount: 1, serverTime: "2026-07-31T14:00:00.000Z" }
      )
    );
    act(() => {
      store.set(bumpOrg2CloudChannelMessagesVersionAtom, { orgId: "org-a" });
    });
    await flushAsync();
    // Second turn: the debounced read cursor that the merged rows scheduled.
    await flushAsync();

    expect(mocks.listCloudChannelMessages).toHaveBeenNthCalledWith(
      2,
      "fresh-token",
      "org-a",
      "chan-1",
      { since: "2026-07-31T12:00:00.000Z" }
    );
    // The edit replaced a row in place, the delete became a tombstone in the
    // same slot, and the new row appended — no re-listing.
    expect(probe().ids).toBe("m1,m2,m3");
    expect(probe().bodies).toBe(",typo fixed,brand new");
    expect(probe().tombstones).toBe("m1");
    // The delta's new row is on screen, so it is immediately read: the cursor
    // moves to it and the server's fresh unread count lands.
    expect(mocks.setCloudChannelReadCursor).toHaveBeenLastCalledWith(
      "fresh-token",
      "org-a",
      "chan-1",
      "2026-07-31T03:00:00.000Z"
    );
    expect(probe().unread).toBe("0");
  });

  it("reloads the page instead of merging a capped delta", async () => {
    mocks.listCloudChannelMessages.mockResolvedValueOnce(
      page([makeMessage({ id: "m1", body: "first" })])
    );
    renderProbe("org-a", "chan-1");
    await flushAsync();

    // `hasMore` on a delta means rows were dropped: merging it would advance
    // the cursor past messages this client never saw.
    mocks.listCloudChannelMessages.mockResolvedValueOnce(
      page([makeMessage({ id: "m9", body: "partial" })], { hasMore: true })
    );
    mocks.listCloudChannelMessages.mockResolvedValueOnce(
      page([
        makeMessage({
          id: "m2",
          body: "reloaded",
          createdAt: "2026-07-31T02:00:00.000Z",
        }),
        makeMessage({ id: "m1", body: "first" }),
      ])
    );
    act(() => {
      store.set(bumpOrg2CloudChannelMessagesVersionAtom, { orgId: "org-a" });
    });
    await flushAsync();

    expect(probe().bodies).toBe("first,reloaded");
    expect(mocks.listCloudChannelMessages).toHaveBeenCalledTimes(3);
    expect(mocks.listCloudChannelMessages).toHaveBeenLastCalledWith(
      "fresh-token",
      "org-a",
      "chan-1",
      { limit: 50 }
    );
  });

  it("shows an optimistic post and rolls it back when the server refuses", async () => {
    mocks.listCloudChannelMessages.mockResolvedValue(
      page([makeMessage({ id: "m1", body: "first" })])
    );
    renderProbe("org-a", "chan-1");
    await flushAsync();

    const pending = deferred<CloudChannelMessage>();
    mocks.postCloudChannelMessage.mockReturnValue(pending.promise);
    let rejection: Promise<void> | null = null;
    act(() => {
      rejection = state().postMessage("managers only, sorry");
      // The rejection is asserted below; keep the runtime from flagging the
      // brief window where nothing is attached yet.
      rejection.catch(() => undefined);
    });
    // The row is on screen before the server has answered.
    expect(probe().bodies).toBe("first,managers only, sorry");

    const refusal = new Org2CloudChannelMessagesError(
      "post refused (ORG2_CHANNEL_POST_FORBIDDEN)",
      403
    );
    await act(async () => {
      pending.reject(refusal);
      await expect(rejection).rejects.toBe(refusal);
    });

    // Rolled back to exactly the server's truth, and the code survives the
    // rethrow so the composer can explain WHY.
    expect(probe().bodies).toBe("first");
    expect(refusal.code).toBe("ORG2_CHANNEL_POST_FORBIDDEN");
  });

  it("replaces the optimistic row with the server row on success", async () => {
    mocks.listCloudChannelMessages.mockResolvedValue(page([]));
    renderProbe("org-a", "chan-1");
    await flushAsync();

    mocks.postCloudChannelMessage.mockResolvedValue(
      makeMessage({
        id: "server-1",
        body: "ship it",
        createdAt: "2026-07-31T05:00:00.000Z",
      })
    );
    await act(async () => {
      await state().postMessage("ship it");
    });

    expect(probe().ids).toBe("server-1");
    expect(probe().bodies).toBe("ship it");
    // No `orgChannelMessagesIdempotency` in the probe answer, so no options —
    // sending `p_client_key` to a pre-0016 backend is a signature mismatch.
    expect(mocks.postCloudChannelMessage).toHaveBeenCalledWith(
      "fresh-token",
      "org-a",
      "chan-1",
      "ship it",
      undefined
    );
  });

  it("keys posts when the backend advertises idempotency and drops the optimistic row on its delta echo", async () => {
    mocks.getCloudCapabilities.mockResolvedValue({
      orgChannelMessages: true,
      orgChannelMessagesIdempotency: true,
    });
    mocks.listCloudChannelMessages.mockResolvedValueOnce(
      page([makeMessage({ id: "m1", body: "first" })])
    );
    renderProbe("org-a", "chan-1");
    await flushAsync();

    const pending = deferred<CloudChannelMessage>();
    mocks.postCloudChannelMessage.mockReturnValue(pending.promise);
    let ack: Promise<void> | null = null;
    act(() => {
      ack = state().postMessage("echo me");
    });
    expect(probe().bodies).toBe("first,echo me");
    // The token fetch sits between the call and the RPC; let it settle so the
    // generated key can be read off the mock.
    await flushAsync();

    const options = mocks.postCloudChannelMessage.mock.calls[0][4] as {
      clientKey?: string;
    };
    const clientKey = options?.clientKey;
    expect(typeof clientKey).toBe("string");
    expect(clientKey).not.toBe("");

    // The realtime delta beats the post's own ack: the server row arrives
    // carrying the key, and the pending twin must leave with it — one row on
    // screen, never two copies of the same message.
    const serverRow = makeMessage({
      id: "server-2",
      body: "echo me",
      createdAt: "2026-07-31T13:00:00.000Z",
      stateChangedAt: "2026-07-31T13:00:00.000Z",
      clientKey,
    });
    mocks.listCloudChannelMessages.mockResolvedValueOnce(
      page([serverRow], { serverTime: "2026-07-31T14:00:00.000Z" })
    );
    act(() => {
      store.set(bumpOrg2CloudChannelMessagesVersionAtom, { orgId: "org-a" });
    });
    await flushAsync();
    expect(probe().ids).toBe("m1,server-2");
    expect(probe().bodies).toBe("first,echo me");

    // The late ack ships the same identity; merging it changes nothing.
    await act(async () => {
      pending.resolve(serverRow);
      await ack;
    });
    expect(probe().ids).toBe("m1,server-2");
    expect(probe().bodies).toBe("first,echo me");
  });

  it("writes the read cursor for the newest row and takes the server's unread count", async () => {
    mocks.listCloudChannelMessages.mockResolvedValue(
      page(
        [
          makeMessage({
            id: "m2",
            body: "newest",
            createdAt: "2026-07-31T02:00:00.000Z",
          }),
          makeMessage({
            id: "m1",
            body: "older",
            createdAt: "2026-07-31T01:00:00.000Z",
          }),
        ],
        { unreadCount: 2 }
      )
    );
    mocks.setCloudChannelReadCursor.mockResolvedValue({
      lastReadAt: "2026-07-31T02:00:00.000Z",
      unreadCount: 0,
    });
    renderProbe("org-a", "chan-1");
    await flushAsync();
    await flushAsync();

    expect(mocks.setCloudChannelReadCursor).toHaveBeenCalledWith(
      "fresh-token",
      "org-a",
      "chan-1",
      "2026-07-31T02:00:00.000Z"
    );
    expect(probe().unread).toBe("0");
    // Debounced + deduped: a re-render with the same newest row must not
    // re-write the cursor.
    await flushAsync();
    expect(mocks.setCloudChannelReadCursor).toHaveBeenCalledTimes(1);
  });

  it("drops a stale completion that lands after a channel switch", async () => {
    const listByChannel = new Map<string, Deferred<CloudChannelMessagesPage>>();
    mocks.listCloudChannelMessages.mockImplementation(
      (_token: string, _orgId: string, channelId: string) => {
        const pending = deferred<CloudChannelMessagesPage>();
        listByChannel.set(channelId, pending);
        return pending.promise;
      }
    );

    renderProbe("org-a", "chan-1");
    await flushAsync();
    expect(probe().phase).toBe("loading");

    renderProbe("org-a", "chan-2");
    await flushAsync();

    // Channel 1's page settles LATE — it must never reach channel 2's surface.
    act(() => {
      listByChannel
        .get("chan-1")
        ?.resolve(page([makeMessage({ id: "leak", body: "chan-1 secret" })]));
    });
    await flushAsync();
    expect(probe().phase).toBe("loading");
    expect(probe().bodies).toBe("");

    act(() => {
      listByChannel
        .get("chan-2")
        ?.resolve(page([makeMessage({ id: "ok", body: "chan-2 message" })]));
    });
    await flushAsync();
    expect(probe().phase).toBe("ready");
    expect(probe().bodies).toBe("chan-2 message");
  });

  it("reports a failed page read as the error phase", async () => {
    mocks.listCloudChannelMessages.mockRejectedValue(new Error("boom"));
    renderProbe("org-a", "chan-1");
    await flushAsync();

    expect(probe().phase).toBe("error");
    expect(probe().error).toBe("boom");
    expect(probe().bodies).toBe("");
  });
});
