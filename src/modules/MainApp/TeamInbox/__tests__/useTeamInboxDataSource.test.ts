// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectData } from "@src/api/http/project";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  type Org2CloudOrg,
  org2CloudOrgsAtom,
  org2CloudRosterVersionAtom,
  sidebarActiveCloudOrgIdAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { type SmokeRoot, createSmokeRoot } from "@src/test/reactSmokeHarness";

import { teamInboxInvalidationAtom } from "../store";
import type { TeamInboxCoordinatorScope } from "../teamInboxCoordinator";
import {
  __TEAM_INBOX_MEMBER_INTERNALS,
  useTeamInboxDataSource,
} from "../useTeamInboxDataSource";

const mocks = vi.hoisted(() => ({
  coordinatorEnsureScope: vi.fn(),
  coordinatorInvalidate: vi.fn(),
  coordinatorLoadMore: vi.fn(),
  coordinatorMarkAllRead: vi.fn(),
  coordinatorMarkRead: vi.fn(),
  coordinatorMarkUnread: vi.fn(),
  coordinatorReconcileItem: vi.fn(),
  coordinatorRefresh: vi.fn(),
  createWorkItemFromSession: vi.fn(),
  invalidateProjectCache: vi.fn(),
  loadCloudOrgMembers: vi.fn(),
  loggerWarn: vi.fn(),
  readMembers: vi.fn(),
  readProject: vi.fn(),
  readProjects: vi.fn(),
  resolveCurrentUserMemberIds: vi.fn(),
  sessionHandoffDraft: vi.fn(),
  useProjectDataChanged: vi.fn(),
}));

vi.mock("@src/api/http/project", () => ({
  invalidateProjectCache: mocks.invalidateProjectCache,
  projectApi: {
    readMembers: mocks.readMembers,
    readProject: mocks.readProject,
    readProjects: mocks.readProjects,
  },
}));

vi.mock("@src/features/Org2Cloud/org2CloudMembersCoordinator", () => ({
  loadCloudOrgMembers: mocks.loadCloudOrgMembers,
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ warn: mocks.loggerWarn }),
}));

vi.mock("@src/hooks/project", () => ({
  useProjectDataChanged: mocks.useProjectDataChanged,
}));

vi.mock("@src/hooks/project/useCurrentUserMemberId", () => ({
  useCurrentUserMemberIds: mocks.resolveCurrentUserMemberIds,
}));

vi.mock("../createWorkItemFromSession", () => ({
  createWorkItemFromSession: mocks.createWorkItemFromSession,
  sessionHandoffDraft: mocks.sessionHandoffDraft,
}));

vi.mock("../teamInboxCoordinator", () => ({
  teamInboxCoordinator: {
    ensureScope: mocks.coordinatorEnsureScope,
    invalidate: mocks.coordinatorInvalidate,
    loadMore: mocks.coordinatorLoadMore,
    markAllRead: mocks.coordinatorMarkAllRead,
    markRead: mocks.coordinatorMarkRead,
    markUnread: mocks.coordinatorMarkUnread,
    reconcileItem: mocks.coordinatorReconcileItem,
    refresh: mocks.coordinatorRefresh,
  },
}));

const AUTH = {
  kind: "org2_cloud" as const,
  supabaseUrl: "https://cloud.example.test",
  supabaseAnonKey: "anon",
  userId: "cloud-viewer",
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 4_102_444_800,
};

function project(slug: string): ProjectData {
  return {
    slug,
    description: "",
    meta: {
      id: `project-${slug}`,
      name: slug,
      org_id: "local-org",
      status: "active",
      priority: "none",
      health: "no_updates",
      members: [],
      labels: [],
      linked_repos: [],
      created_at: "2026-08-21T00:00:00.000Z",
      updated_at: "2026-08-21T00:00:00.000Z",
      next_work_item_id: 1,
      work_item_prefix: "TST",
      work_item_prefix_custom: false,
    },
  };
}

function cloudOrg(orgId: string): Org2CloudOrg {
  return { orgId, name: `Org ${orgId}`, role: "manager" };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

let latestViewerMemberIds: readonly string[] = [];

function Harness(): null {
  const { viewerMemberIds } = useTeamInboxDataSource();
  useEffect(() => {
    latestViewerMemberIds = viewerMemberIds;
  }, [viewerMemberIds]);
  return null;
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

function refreshScopes(): TeamInboxCoordinatorScope[] {
  return mocks.coordinatorRefresh.mock.calls.map(
    (call) => call[1] as TeamInboxCoordinatorScope
  );
}

describe("useTeamInboxDataSource orchestration", () => {
  let root: SmokeRoot;
  let store: ReturnType<typeof createStore>;
  let currentMemberIds: Set<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
    vi.clearAllMocks();
    localStorage.clear();
    latestViewerMemberIds = [];
    __TEAM_INBOX_MEMBER_INTERNALS.resetRequest();
    currentMemberIds = new Set(["viewer-1"]);
    mocks.resolveCurrentUserMemberIds.mockImplementation(() => ({
      memberIds: currentMemberIds,
      gitEmail: "viewer@example.test",
      currentUser: null,
    }));
    mocks.readProjects.mockResolvedValue([]);
    mocks.readMembers.mockResolvedValue({ members: [] });
    mocks.readProject.mockResolvedValue(null);
    mocks.loadCloudOrgMembers.mockResolvedValue(null);
    mocks.coordinatorRefresh.mockResolvedValue(undefined);
    mocks.coordinatorLoadMore.mockResolvedValue(undefined);
    mocks.coordinatorMarkRead.mockResolvedValue(undefined);
    mocks.coordinatorMarkUnread.mockResolvedValue(undefined);
    mocks.coordinatorMarkAllRead.mockResolvedValue(undefined);
    store = createStore();
    store.set(org2CloudAuthAtom, null);
    store.set(org2CloudOrgsAtom, []);
    store.set(sidebarActiveCloudOrgIdAtom, null);
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
  }

  it("retains usable members and reports a partial prerequisite failure", async () => {
    mocks.readProjects.mockResolvedValue([project("alpha"), project("beta")]);
    mocks.readMembers.mockImplementation(async (slug: string) => {
      if (slug === "beta") throw new Error("beta members unavailable");
      return {
        members: [
          {
            id: "viewer-1",
            name: "Viewer",
            active: true,
            last_commit_date: "2026-08-20T00:00:00.000Z",
          },
          { id: "teammate-1", name: "Lin", active: true },
        ],
      };
    });

    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    const latestScope = refreshScopes().at(-1);
    expect(latestScope).toMatchObject({
      viewerMemberIds: ["viewer-1"],
      activeCloudOrgId: null,
      prerequisiteIssue: {
        code: "partial_load",
        detail: "1 project member file(s) could not be read",
      },
    });
    expect(latestScope?.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "viewer-1", name: "Viewer" }),
        expect.objectContaining({ id: "teammate-1", name: "Lin" }),
      ])
    );
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Skipped 1 project member file(s) while resolving Team Inbox identity"
    );
  });

  it("rejects a late cloud roster after switching to a different org scope", async () => {
    const orgA = deferred<{
      members: Array<{
        userId: string;
        displayName: string;
        role: "member";
        status: string;
      }>;
    }>();
    const orgB = deferred<{
      members: Array<{
        userId: string;
        displayName: string;
        role: "member";
        status: string;
      }>;
    }>();
    mocks.loadCloudOrgMembers.mockImplementation(
      (_store: unknown, _auth: unknown, orgId: string) =>
        orgId === "org-a" ? orgA.promise : orgB.promise
    );
    store.set(org2CloudAuthAtom, AUTH);
    store.set(org2CloudOrgsAtom, [cloudOrg("org-a"), cloudOrg("org-b")]);
    store.set(org2CloudRosterVersionAtom, { "org-a": 1, "org-b": 1 });
    store.set(sidebarActiveCloudOrgIdAtom, "org-a");

    await mount();
    await act(async () => {
      store.set(sidebarActiveCloudOrgIdAtom, "org-b");
    });
    await flushAsync();

    orgB.resolve({
      members: [
        {
          userId: "member-b",
          displayName: "Member B",
          role: "member",
          status: "active",
        },
      ],
    });
    await flushAsync();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    orgA.resolve({
      members: [
        {
          userId: "member-a",
          displayName: "Stale Member A",
          role: "member",
          status: "active",
        },
      ],
    });
    await flushAsync();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    const orgBScopes = refreshScopes().filter(
      (scope) => scope.activeCloudOrgId === "org-b"
    );
    expect(orgBScopes.length).toBeGreaterThan(0);
    expect(orgBScopes.at(-1)?.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "member-b", name: "Member B" }),
      ])
    );
    expect(
      orgBScopes.some((scope) =>
        scope.members.some((member) => member.id === "member-a")
      )
    ).toBe(false);
    expect(latestViewerMemberIds).toEqual(["cloud-viewer", "viewer-1"]);
  });

  it("rejects a late roster from a previous authenticated identity in the same org", async () => {
    const identityA = deferred<{
      members: Array<{
        userId: string;
        displayName: string;
        role: "member";
        status: string;
      }>;
    }>();
    const identityB = deferred<{
      members: Array<{
        userId: string;
        displayName: string;
        role: "member";
        status: string;
      }>;
    }>();
    mocks.loadCloudOrgMembers.mockImplementation(
      (_store: unknown, auth: { userId: string }) =>
        auth.userId === "cloud-viewer" ? identityA.promise : identityB.promise
    );
    store.set(org2CloudAuthAtom, AUTH);
    store.set(org2CloudOrgsAtom, [cloudOrg("org-a")]);
    store.set(org2CloudRosterVersionAtom, { "org-a": 1 });
    store.set(sidebarActiveCloudOrgIdAtom, "org-a");

    await mount();
    await act(async () => {
      store.set(org2CloudAuthAtom, {
        ...AUTH,
        supabaseUrl: "https://other-cloud.example.test",
        userId: "cloud-viewer-b",
        accessToken: "access-b",
        refreshToken: "refresh-b",
      });
    });
    await flushAsync();

    identityB.resolve({
      members: [
        {
          userId: "member-b",
          displayName: "Current Member B",
          role: "member",
          status: "active",
        },
      ],
    });
    await flushAsync();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    identityA.resolve({
      members: [
        {
          userId: "member-a",
          displayName: "Stale Member A",
          role: "member",
          status: "active",
        },
      ],
    });
    await flushAsync();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    const identityBScopes = refreshScopes().filter((scope) =>
      scope.viewerMemberIds.includes("cloud-viewer-b")
    );
    expect(identityBScopes.length).toBeGreaterThan(0);
    expect(identityBScopes.at(-1)?.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "member-b", name: "Current Member B" }),
      ])
    );
    expect(
      identityBScopes.some((scope) =>
        scope.members.some((member) => member.id === "member-a")
      )
    ).toBe(false);
    expect(latestViewerMemberIds).toEqual(["cloud-viewer-b", "viewer-1"]);
  });

  it("shares one local roster request across concurrent mounted consumers", async () => {
    const projects = deferred<ProjectData[]>();
    mocks.readProjects.mockReturnValue(projects.promise);

    await root.render(
      createElement(
        Provider,
        { store },
        createElement(
          "div",
          null,
          createElement(Harness),
          createElement(Harness)
        )
      )
    );

    expect(mocks.readProjects).toHaveBeenCalledOnce();
    projects.resolve([]);
    await flushAsync();
    expect(mocks.readProjects).toHaveBeenCalledOnce();
  });

  it("coalesces invalidation bursts and cancels the trailing refresh on unmount", async () => {
    await mount();
    expect(mocks.coordinatorRefresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      store.set(teamInboxInvalidationAtom, 1);
      store.set(teamInboxInvalidationAtom, 2);
    });
    await flushAsync();
    expect(mocks.coordinatorRefresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mocks.coordinatorRefresh).toHaveBeenCalledTimes(2);
    expect(mocks.coordinatorRefresh.mock.calls.at(-1)?.[2]).toMatch(/^2:/);

    await act(async () => {
      store.set(teamInboxInvalidationAtom, 3);
    });
    await flushAsync();
    const callsBeforeUnmount = mocks.coordinatorRefresh.mock.calls.length;
    await root.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mocks.coordinatorRefresh).toHaveBeenCalledTimes(callsBeforeUnmount);
  });
});
