// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import { activeSessionIdAtom } from "@src/store/session/viewAtom";
import { chatPanelSelectedCloudOrgAtom } from "@src/store/ui/chatPanelAtom";
import { type SmokeRoot, createSmokeRoot } from "@src/test/reactSmokeHarness";

import { org2CloudAuthAtom } from "./org2CloudAuthAtom";
import {
  type Org2CloudOrg,
  org2CloudOrgsAtom,
  sidebarActiveCloudOrgIdAtom,
} from "./org2CloudOrgsAtom";
import type {
  Org2CloudPresenceHandle,
  Org2CloudPresenceOptions,
  Org2CloudRealtimeConnection,
  Org2CloudSubscribeOptions,
} from "./org2CloudRealtimeClient";
import { useOrg2CloudRealtime } from "./useOrg2CloudRealtime";

const mocks = vi.hoisted(() => ({
  clearCloudOrgMembersCache: vi.fn(),
  createConnection: vi.fn(),
  ensureFreshSession: vi.fn(),
  getCloudCapabilities: vi.fn(),
  invalidateOrgInbound: vi.fn(),
  refetchOrgs: vi.fn(),
  refreshOrgEntitlement: vi.fn(),
  registerCommentsBroadcaster: vi.fn(),
  registerOrgControlBroadcaster: vi.fn(),
  resumeOrg: vi.fn(),
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock("./org2CloudRealtimeClient", () => ({
  createOrg2CloudRealtimeConnection: mocks.createConnection,
}));

vi.mock("./org2CloudRealtimeLease", () => ({
  useOrg2CloudRealtimeLease: () => true,
}));

vi.mock("./org2CloudCapabilities", () => ({
  getCloudCapabilities: mocks.getCloudCapabilities,
}));

vi.mock("./org2CloudClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./org2CloudClient")>()),
  ensureFreshSession: mocks.ensureFreshSession,
}));

vi.mock("./org2CloudOrgsAtom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./org2CloudOrgsAtom")>()),
  useRefetchOrg2CloudOrgs: () => mocks.refetchOrgs,
}));

vi.mock("./org2CloudMembersCoordinator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./org2CloudMembersCoordinator")>()),
  clearCloudOrgMembersCache: mocks.clearCloudOrgMembersCache,
}));

vi.mock("./org2CloudEntitlementCoordinator", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./org2CloudEntitlementCoordinator")
  >()),
  refreshOrgEntitlement: mocks.refreshOrgEntitlement,
}));

vi.mock("./org2CloudCommentsBus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./org2CloudCommentsBus")>()),
  registerCommentsBroadcaster: mocks.registerCommentsBroadcaster,
}));

vi.mock("./org2CloudControlBus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./org2CloudControlBus")>()),
  registerOrgControlBroadcaster: mocks.registerOrgControlBroadcaster,
}));

vi.mock("./org2CloudSyncEngine", () => ({
  org2CloudSyncEngine: {
    invalidateOrgInbound: mocks.invalidateOrgInbound,
    resumeOrg: mocks.resumeOrg,
  },
}));

interface ControlledSubscription {
  options: Org2CloudSubscribeOptions;
  unsubscribe: ReturnType<typeof vi.fn>;
}

interface ControlledPresence {
  options: Org2CloudPresenceOptions;
  handle: Org2CloudPresenceHandle & {
    update: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    leave: ReturnType<typeof vi.fn>;
  };
}

interface ControlledConnection extends Org2CloudRealtimeConnection {
  subscriptions: ControlledSubscription[];
  presences: ControlledPresence[];
  setAuth: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

const connections: ControlledConnection[] = [];
const broadcasterUnregisters: Array<ReturnType<typeof vi.fn>> = [];

function createControlledConnection(): ControlledConnection {
  const subscriptions: ControlledSubscription[] = [];
  const presences: ControlledPresence[] = [];
  const connection: ControlledConnection = {
    subscriptions,
    presences,
    subscribe: vi.fn((options: Org2CloudSubscribeOptions) => {
      const unsubscribe = vi.fn();
      subscriptions.push({ options, unsubscribe });
      return unsubscribe;
    }),
    joinPresence: vi.fn((options: Org2CloudPresenceOptions) => {
      const handle = {
        update: vi.fn(),
        send: vi.fn(),
        leave: vi.fn(),
      };
      presences.push({ options, handle });
      return handle;
    }),
    setAuth: vi.fn(),
    dispose: vi.fn(),
  };
  connections.push(connection);
  return connection;
}

const AUTH = {
  kind: "org2_cloud" as const,
  supabaseUrl: "https://cloud.example.test",
  supabaseAnonKey: "anon",
  userId: "user-a",
  accessToken: "access-a",
  refreshToken: "refresh-a",
  expiresAt: 4_102_444_800,
  profile: { displayName: "Ada" },
};

function cloudOrg(orgId: string): Org2CloudOrg {
  return { orgId, name: `Org ${orgId}`, role: "manager" };
}

function Harness(): null {
  useOrg2CloudRealtime();
  return null;
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useOrg2CloudRealtime lifecycle", () => {
  let root: SmokeRoot;
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
    vi.clearAllMocks();
    connections.splice(0);
    broadcasterUnregisters.splice(0);
    localStorage.clear();
    mocks.createConnection.mockImplementation(createControlledConnection);
    mocks.ensureFreshSession.mockImplementation(async (auth) => auth);
    mocks.getCloudCapabilities.mockResolvedValue({ broadcastSignals: false });
    mocks.refetchOrgs.mockResolvedValue(undefined);
    mocks.refreshOrgEntitlement.mockResolvedValue(undefined);
    const registerBroadcaster = () => {
      const unregister = vi.fn();
      broadcasterUnregisters.push(unregister);
      return unregister;
    };
    mocks.registerCommentsBroadcaster.mockImplementation(registerBroadcaster);
    mocks.registerOrgControlBroadcaster.mockImplementation(registerBroadcaster);
    store = createStore();
    store.set(org2CloudAuthAtom, AUTH);
    store.set(org2CloudOrgsAtom, [cloudOrg("org-a"), cloudOrg("org-b")]);
    store.set(sidebarActiveCloudOrgIdAtom, "org-a");
    store.set(chatPanelSelectedCloudOrgAtom, null);
    store.set(activeSessionIdAtom, null);
    store.set(sessionsAtom, []);
    root = createSmokeRoot();
  });

  afterEach(async () => {
    await root.unmount();
    vi.useRealTimers();
    localStorage.clear();
  });

  async function mount(): Promise<void> {
    await root.render(
      createElement(Provider, { store }, createElement(Harness))
    );
    await flushAsync();
    expect(connections).toHaveLength(1);
  }

  function subscription(
    connection: ControlledConnection,
    table: string,
    filter: string
  ): ControlledSubscription {
    const match = connection.subscriptions.find(
      (entry) =>
        entry.options.table === table && entry.options.filter === filter
    );
    expect(match).toBeDefined();
    return match!;
  }

  it("owns only the active org subscriptions and disposes every resource on scope switch", async () => {
    await mount();
    const first = connections[0]!;

    expect(first.subscriptions).toHaveLength(3);
    subscription(first, "org_memberships", "user_id=eq.user-a");
    subscription(first, "org_change_signals", "org_id=eq.org-a");
    subscription(first, "org_memberships", "org_id=eq.org-a");
    expect(first.presences).toHaveLength(1);
    expect(first.presences[0]?.options).toMatchObject({
      scope: "org:org-a",
      key: "user-a",
    });

    await act(async () => {
      store.set(sidebarActiveCloudOrgIdAtom, "org-b");
    });
    await flushAsync();

    expect(connections).toHaveLength(2);
    expect(first.dispose).toHaveBeenCalledOnce();
    for (const entry of first.subscriptions) {
      expect(entry.unsubscribe).toHaveBeenCalledOnce();
    }
    expect(first.presences[0]?.handle.leave).toHaveBeenCalledOnce();
    for (const unregister of broadcasterUnregisters.slice(0, 2)) {
      expect(unregister).toHaveBeenCalledOnce();
    }

    const second = connections[1]!;
    subscription(second, "org_change_signals", "org_id=eq.org-b");
    subscription(second, "org_memberships", "org_id=eq.org-b");
    expect(second.presences[0]?.options.scope).toBe("org:org-b");
  });

  it("keeps the same connection on token rotation and nudges its auth callback", async () => {
    await mount();
    const connection = connections[0]!;
    const initialSetAuthCalls = connection.setAuth.mock.calls.length;

    await act(async () => {
      store.set(org2CloudAuthAtom, { ...AUTH, accessToken: "access-rotated" });
    });
    await flushAsync();

    expect(connections).toHaveLength(1);
    expect(connection.dispose).not.toHaveBeenCalled();
    expect(connection.setAuth).toHaveBeenCalledTimes(initialSetAuthCalls + 1);
  });

  it("fully rebinds realtime ownership when the authenticated identity and endpoint change", async () => {
    await mount();
    const first = connections[0]!;

    await act(async () => {
      store.set(org2CloudAuthAtom, {
        ...AUTH,
        supabaseUrl: "https://other-cloud.example.test",
        userId: "user-b",
        accessToken: "access-b",
        refreshToken: "refresh-b",
      });
    });
    await flushAsync();

    expect(connections).toHaveLength(2);
    expect(first.dispose).toHaveBeenCalledOnce();
    for (const entry of first.subscriptions) {
      expect(entry.unsubscribe).toHaveBeenCalledOnce();
    }
    expect(first.presences[0]?.handle.leave).toHaveBeenCalledOnce();

    const second = connections[1]!;
    subscription(second, "org_memberships", "user_id=eq.user-b");
    expect(second.presences[0]?.options).toMatchObject({
      scope: "org:org-a",
      key: "user-b",
    });
  });

  it("migrates from legacy change channels to the broadcast channel without replacing the socket", async () => {
    mocks.getCloudCapabilities.mockResolvedValue({ broadcastSignals: true });
    await mount();
    const connection = connections[0]!;
    const ownRoster = subscription(
      connection,
      "org_memberships",
      "user_id=eq.user-a"
    );
    const legacySignal = subscription(
      connection,
      "org_change_signals",
      "org_id=eq.org-a"
    );
    const legacyRoster = subscription(
      connection,
      "org_memberships",
      "org_id=eq.org-a"
    );

    await vi.waitFor(() => expect(connection.presences).toHaveLength(2), {
      timeout: 5_000,
    });

    expect(connections).toHaveLength(1);
    expect(connection.dispose).not.toHaveBeenCalled();
    expect(ownRoster.unsubscribe).not.toHaveBeenCalled();
    expect(legacySignal.unsubscribe).toHaveBeenCalledOnce();
    expect(legacyRoster.unsubscribe).toHaveBeenCalledOnce();
    expect(connection.presences[0]?.handle.leave).toHaveBeenCalledOnce();

    act(() => connection.presences[1]?.options.onStatus?.(true));
    expect(mocks.invalidateOrgInbound).toHaveBeenCalledWith("org-a");
  });

  it("does not claim hidden subscribed-edge recovery and clears its safety timer on teardown", async () => {
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    await mount();
    const connection = connections[0]!;
    const signalSubscription = subscription(
      connection,
      "org_change_signals",
      "org_id=eq.org-a"
    );
    const baselineTimerCount = vi.getTimerCount();

    act(() => signalSubscription.options.onStatus?.(true));
    expect(mocks.invalidateOrgInbound).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(baselineTimerCount);

    visibility.mockReturnValue("visible");
    act(() => signalSubscription.options.onStatus?.(true));
    expect(mocks.invalidateOrgInbound).toHaveBeenCalledWith("org-a", {
      full: true,
      pushSessions: true,
    });
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 1);

    await root.unmount();
    expect(connection.dispose).toHaveBeenCalledOnce();
    expect(connection.presences[0]?.handle.leave).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(baselineTimerCount);
  });
});
