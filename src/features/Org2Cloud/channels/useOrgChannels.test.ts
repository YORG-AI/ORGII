// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
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
import { bumpOrg2CloudChannelsVersionAtom } from "./channelsAtom";
import type { CloudChannel, CloudChannelsList } from "./types";
import { __ORG_CHANNELS_INTERNALS, useOrgChannels } from "./useOrgChannels";

const mocks = vi.hoisted(() => ({
  ensureFreshSession: vi.fn(),
  getCloudCapabilities: vi.fn(),
  listCloudChannels: vi.fn(),
}));

vi.mock("../org2CloudClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../org2CloudClient")>();
  return { ...actual, ensureFreshSession: mocks.ensureFreshSession };
});

vi.mock("../org2CloudCapabilities", () => ({
  getCloudCapabilities: mocks.getCloudCapabilities,
}));

vi.mock("./channelsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./channelsClient")>();
  return { ...actual, listCloudChannels: mocks.listCloudChannels };
});

const AUTH_A = {
  kind: "org2_cloud" as const,
  supabaseUrl: "https://cloud.example.test",
  supabaseAnonKey: "anon",
  userId: "user-a",
  accessToken: "stale-a",
  refreshToken: "refresh-a",
  expiresAt: 4_102_444_800,
};

/** Different userId ⇒ different `org2CloudAuthIdentityKey`. */
const AUTH_B = {
  ...AUTH_A,
  userId: "user-b",
  accessToken: "stale-b",
  refreshToken: "refresh-b",
};

function makeChannel(
  id: string,
  name: string,
  archivedAt: string | null = null
): CloudChannel {
  return {
    id,
    name,
    topic: undefined,
    visibility: "org",
    postPolicy: "everyone",
    createdBy: "user-a",
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: undefined,
    archivedAt,
    messageCount: 0,
    lastMessageAt: undefined,
    memberCount: 1,
    myRole: "manager",
  };
}

function channelsPage(channels: CloudChannel[]): CloudChannelsList {
  return { channels, serverTime: undefined };
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

/**
 * Renders the hook state into data attributes (the
 * `useSessionReferenceDropTarget` harness idiom — render-pure, no
 * module-variable capture).
 */
function Probe(props: { orgId: string | null; includeArchived: boolean }) {
  const state = useOrgChannels(props.orgId, {
    includeArchived: props.includeArchived,
  });
  return createElement("div", {
    "data-testid": "channels-probe",
    "data-phase": state.phase,
    "data-error": state.error ?? "",
    "data-refreshing": String(state.refreshing),
    "data-user": state.currentUserId ?? "",
    "data-channels": state.channels.map((channel) => channel.name).join(","),
    "data-archived": state.archivedChannels
      .map((channel) => channel.name)
      .join(","),
  });
}

describe("useOrgChannels", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    __ORG_CHANNELS_INTERNALS.reset();
    localStorage.clear();
    // Token refresh hands back a NEW auth object carrying the fresh token —
    // every downstream RPC must use it, never the stale atom token.
    mocks.ensureFreshSession.mockImplementation(
      async (state: typeof AUTH_A) => ({
        ...state,
        accessToken: "fresh-token",
      })
    );
    mocks.getCloudCapabilities.mockResolvedValue({ orgChannels: true });
    store = createStore();
    store.set(org2CloudAuthAtom, AUTH_A);
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

  function renderProbe(orgId: string | null, includeArchived = true) {
    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(Probe, { orgId, includeArchived })
        )
      );
    });
  }

  function probe(): DOMStringMap {
    const element = document.querySelector<HTMLElement>(
      '[data-testid="channels-probe"]'
    );
    expect(element).not.toBeNull();
    return (element as HTMLElement).dataset;
  }

  it("reports signedOut without touching the network when there is no auth", async () => {
    store.set(org2CloudAuthAtom, null);
    renderProbe("org-a");
    await flushAsync();

    expect(probe().phase).toBe("signedOut");
    expect(mocks.ensureFreshSession).not.toHaveBeenCalled();
    expect(mocks.listCloudChannels).not.toHaveBeenCalled();
  });

  it("resolves unsupported from the capability probe and never calls the list RPC", async () => {
    mocks.getCloudCapabilities.mockResolvedValue({ orgChannels: false });
    renderProbe("org-a");
    await flushAsync();

    expect(probe().phase).toBe("unsupported");
    expect(mocks.listCloudChannels).not.toHaveBeenCalled();
    // The capability probe itself ran, with the refreshed token.
    expect(mocks.getCloudCapabilities).toHaveBeenCalledWith(
      "fresh-token",
      expect.objectContaining({ supabaseUrl: expect.any(String) })
    );
  });

  it("loads with the fresh token and splits active vs archived channels", async () => {
    mocks.listCloudChannels.mockResolvedValue(
      channelsPage([
        makeChannel("c1", "general"),
        makeChannel("c2", "old-plans", "2026-07-30T00:00:00.000Z"),
      ])
    );
    renderProbe("org-a");
    await flushAsync();

    expect(probe().phase).toBe("ready");
    expect(probe().channels).toBe("general");
    expect(probe().archived).toBe("old-plans");
    expect(probe().error).toBe("");
    expect(probe().refreshing).toBe("false");
    expect(probe().user).toBe("user-a");
    expect(mocks.listCloudChannels).toHaveBeenCalledWith(
      "fresh-token",
      "org-a",
      { includeArchived: true }
    );
  });

  it("coalesces identical in-flight list requests from multiple consumers", async () => {
    const pending = deferred<CloudChannelsList>();
    mocks.listCloudChannels.mockImplementation(() => pending.promise);

    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(
            "div",
            null,
            createElement(Probe, {
              orgId: "org-a",
              includeArchived: true,
            }),
            createElement(Probe, {
              orgId: "org-a",
              includeArchived: true,
            })
          )
        )
      );
    });
    await flushAsync();

    expect(mocks.listCloudChannels).toHaveBeenCalledTimes(1);

    act(() => {
      pending.resolve(channelsPage([makeChannel("c1", "general")]));
    });
    await flushAsync();
    expect(
      document.querySelectorAll(
        '[data-testid="channels-probe"][data-phase="ready"]'
      )
    ).toHaveLength(2);
  });

  it("a version bump during an in-flight listing starts a FRESH request instead of joining the stale one", async () => {
    const first = deferred<CloudChannelsList>();
    const second = deferred<CloudChannelsList>();
    let call = 0;
    mocks.listCloudChannels.mockImplementation(() => {
      call += 1;
      return call === 1 ? first.promise : second.promise;
    });

    renderProbe("org-a");
    await flushAsync();
    expect(mocks.listCloudChannels).toHaveBeenCalledTimes(1);

    // The mutation's realtime bump arrives while the PRE-mutation listing is
    // still in flight. Joining it would launder the stale (pre-mutation)
    // result past the seq/channelsKey guards and feed tab reconciliation an
    // authoritative listing that is missing the just-created channel.
    act(() => {
      store.set(bumpOrg2CloudChannelsVersionAtom, "org-a");
    });
    await flushAsync();
    expect(mocks.listCloudChannels).toHaveBeenCalledTimes(2);

    act(() => {
      first.resolve(channelsPage([makeChannel("c1", "stale-view")]));
      second.resolve(
        channelsPage([
          makeChannel("c1", "stale-view"),
          makeChannel("c2", "just-created"),
        ])
      );
    });
    await flushAsync();
    expect(probe().phase).toBe("ready");
    expect(probe().channels).toBe("stale-view,just-created");
  });

  it("never surfaces archived channels when includeArchived is off", async () => {
    mocks.listCloudChannels.mockResolvedValue(
      channelsPage([
        makeChannel("c1", "general"),
        makeChannel("c2", "old-plans", "2026-07-30T00:00:00.000Z"),
      ])
    );
    renderProbe("org-a", false);
    await flushAsync();

    expect(probe().phase).toBe("ready");
    expect(probe().channels).toBe("general");
    expect(probe().archived).toBe("");
    expect(mocks.listCloudChannels).toHaveBeenCalledWith(
      "fresh-token",
      "org-a",
      { includeArchived: false }
    );
  });

  it("drops a stale completion that lands after an org switch (no cross-org leak)", async () => {
    const listByOrg = new Map<string, Deferred<CloudChannelsList>>();
    mocks.listCloudChannels.mockImplementation(
      (_token: string, orgId: string) => {
        const pending = deferred<CloudChannelsList>();
        listByOrg.set(orgId, pending);
        return pending.promise;
      }
    );

    renderProbe("org-a");
    await flushAsync();
    expect(probe().phase).toBe("loading");

    // Switch orgs while org A's fetch is still in flight...
    renderProbe("org-b");
    await flushAsync();

    // ...then let org A's fetch settle LATE. It must be discarded.
    act(() => {
      listByOrg
        .get("org-a")
        ?.resolve(channelsPage([makeChannel("a1", "org-a-secret")]));
    });
    await flushAsync();
    expect(probe().phase).toBe("loading");
    expect(probe().channels).toBe("");

    act(() => {
      listByOrg
        .get("org-b")
        ?.resolve(channelsPage([makeChannel("b1", "org-b-public")]));
    });
    await flushAsync();
    expect(probe().phase).toBe("ready");
    expect(probe().channels).toBe("org-b-public");
  });

  it("refetches on the org's version bump and ignores bumps for other orgs", async () => {
    mocks.listCloudChannels.mockResolvedValue(
      channelsPage([makeChannel("c1", "general")])
    );
    renderProbe("org-a");
    await flushAsync();
    expect(probe().phase).toBe("ready");
    expect(mocks.listCloudChannels).toHaveBeenCalledTimes(1);

    // Realtime `channels` signal for THIS org ⇒ refetch.
    act(() => {
      store.set(bumpOrg2CloudChannelsVersionAtom, "org-a");
    });
    await flushAsync();
    expect(mocks.listCloudChannels).toHaveBeenCalledTimes(2);
    expect(probe().phase).toBe("ready");

    // A bump for a DIFFERENT org must not trigger anything.
    act(() => {
      store.set(bumpOrg2CloudChannelsVersionAtom, "org-elsewhere");
    });
    await flushAsync();
    expect(mocks.listCloudChannels).toHaveBeenCalledTimes(2);
  });

  it("refetches when a blurred desktop window regains focus", async () => {
    mocks.listCloudChannels
      .mockResolvedValueOnce(channelsPage([makeChannel("c1", "before")]))
      .mockResolvedValueOnce(channelsPage([makeChannel("c1", "after")]));
    renderProbe("org-a");
    await flushAsync();
    expect(probe().channels).toBe("before");

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await flushAsync();

    expect(mocks.listCloudChannels).toHaveBeenCalledTimes(2);
    expect(probe().channels).toBe("after");
  });

  it("surfaces a list failure as the error phase with the message", async () => {
    mocks.listCloudChannels.mockRejectedValue(new Error("boom"));
    renderProbe("org-a");
    await flushAsync();

    expect(probe().phase).toBe("error");
    expect(probe().error).toBe("boom");
    expect(probe().channels).toBe("");
  });

  it("wipes state back to loading on an identity switch, then loads the new identity", async () => {
    mocks.listCloudChannels.mockResolvedValue(
      channelsPage([makeChannel("a1", "identity-a-channel")])
    );
    renderProbe("org-a");
    await flushAsync();
    expect(probe().phase).toBe("ready");

    // Account switch: the next fetch is held open so the intermediate state
    // is observable.
    const pending = deferred<CloudChannelsList>();
    mocks.listCloudChannels.mockImplementation(() => pending.promise);
    act(() => {
      store.set(org2CloudAuthAtom, AUTH_B);
    });
    await flushAsync();

    // Identity A's list must never be visible under identity B.
    expect(probe().phase).toBe("loading");
    expect(probe().channels).toBe("");
    expect(probe().user).toBe("user-b");

    act(() => {
      pending.resolve(channelsPage([makeChannel("b1", "identity-b-channel")]));
    });
    await flushAsync();
    expect(probe().phase).toBe("ready");
    expect(probe().channels).toBe("identity-b-channel");
  });
});
