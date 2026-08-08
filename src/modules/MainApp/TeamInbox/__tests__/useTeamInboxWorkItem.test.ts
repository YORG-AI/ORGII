// @vitest-environment jsdom
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

import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import type { WorkItem } from "@src/types/core/workItem";

import {
  type TeamInboxWorkItemState,
  useTeamInboxWorkItem,
} from "../useTeamInboxWorkItem";

const mocks = vi.hoisted(() => ({
  readWorkItem: vi.fn(),
  readProject: vi.fn(),
  readMembers: vi.fn(),
  readStandaloneWorkItem: vi.fn(),
  updateStandaloneWorkItemPartial: vi.fn(),
  transitionStandaloneWorkItemHandoff: vi.fn(),
  transitionWorkItemHandoff: vi.fn(),
  updateWorkItemPartial: vi.fn(),
  loadCloudOrgMembers: vi.fn(),
}));

vi.mock("@src/api/http/project", () => ({
  projectApi: {
    readWorkItem: mocks.readWorkItem,
    readProject: mocks.readProject,
    readMembers: mocks.readMembers,
    readStandaloneWorkItem: mocks.readStandaloneWorkItem,
    updateStandaloneWorkItemPartial: mocks.updateStandaloneWorkItemPartial,
    transitionStandaloneWorkItemHandoff:
      mocks.transitionStandaloneWorkItemHandoff,
    transitionWorkItemHandoff: mocks.transitionWorkItemHandoff,
    updateWorkItemPartial: mocks.updateWorkItemPartial,
  },
  standaloneWorkItemDataToEnriched: (value: unknown) => value,
  enrichedWorkItemToUI: (value: unknown) => value,
}));

vi.mock("@src/hooks/project/useCurrentUserMemberId", () => ({
  useCurrentUserMemberIds: () => ({ currentUser: null }),
}));

vi.mock("@src/features/Org2Cloud/org2CloudMembersCoordinator", () => ({
  loadCloudOrgMembers: mocks.loadCloudOrgMembers,
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

vi.mock("@src/modules/ProjectManager/WorkItems/workItemPartialUpdate", () => ({
  toWorkItemPartialUpdate: (value: unknown) => value,
}));

const WORK_ITEM: WorkItem = {
  session_id: "AAA-0001",
  user_id: "member-1",
  name: "Inbox item",
  status: "planned",
  workItemStatus: "planned",
  priority: "medium",
  spec: "Body",
  assignee: { id: "member-1", name: "Ada" },
  star: false,
  target_date: null,
  created_time: "2026-07-28T00:00:00.000Z",
  updated_time: "2026-07-28T00:00:00.000Z",
  linkedSessions: [],
  todos: [],
};

let latestState: TeamInboxWorkItemState | null = null;

function Probe({ observedUpdatedAt }: { observedUpdatedAt?: string }) {
  const state = useTeamInboxWorkItem(
    {
      kind: "work_item",
      projectId: "demo",
      workItemId: "AAA-0001",
    },
    undefined,
    observedUpdatedAt
  );
  useEffect(() => {
    latestState = state;
  }, [state]);
  return null;
}

function StandaloneProbe() {
  const state = useTeamInboxWorkItem({
    kind: "work_item",
    orgId: "cloud-org-1",
    projectId: "",
    workItemId: "AAA-0001",
  });
  useEffect(() => {
    latestState = state;
  }, [state]);
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("useTeamInboxWorkItem", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    latestState = null;
    vi.clearAllMocks();
    mocks.readWorkItem.mockResolvedValue(WORK_ITEM);
    mocks.readProject.mockResolvedValue({
      slug: "demo",
      meta: { name: "Demo", linked_repos: [] },
    });
    mocks.readMembers.mockResolvedValue({ members: [] });
    mocks.updateStandaloneWorkItemPartial.mockResolvedValue(WORK_ITEM);
    mocks.transitionStandaloneWorkItemHandoff.mockResolvedValue(WORK_ITEM);
    mocks.loadCloudOrgMembers.mockResolvedValue(null);
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

  it("keeps the Work Item usable when optional project context fails", async () => {
    mocks.readMembers.mockRejectedValueOnce(new Error("members unavailable"));

    await act(async () => {
      root.render(createElement(Probe));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(latestState).toMatchObject({
      status: "ready",
      workItem: WORK_ITEM,
      members: [],
      issue: "context_unavailable",
    });
  });

  it("uses the blocking state only when the required Work Item read fails", async () => {
    mocks.readWorkItem.mockRejectedValueOnce(new Error("item unavailable"));

    await act(async () => {
      root.render(createElement(Probe));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(latestState).toMatchObject({
      status: "error",
      workItem: null,
      issue: "load_failed",
    });
    // Context reads are independent and start in parallel so the successful
    // detail path has no required-read waterfall.
    expect(mocks.readProject).toHaveBeenCalledTimes(1);
    expect(mocks.readMembers).toHaveBeenCalledTimes(1);
  });

  it("serializes same-item updates so response order follows user intent", async () => {
    const first = deferred<WorkItem>();
    const second = deferred<WorkItem>();
    mocks.updateWorkItemPartial
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    await act(async () => {
      root.render(createElement(Probe));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => {
      latestState?.updateWorkItem({ workItemStatus: "in_review" });
      latestState?.updateWorkItem({ priority: "high" });
    });
    await Promise.resolve();
    expect(mocks.updateWorkItemPartial).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({
        ...WORK_ITEM,
        status: "in_review",
        workItemStatus: "in_review",
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.updateWorkItemPartial).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve({
        ...WORK_ITEM,
        status: "in_review",
        workItemStatus: "in_review",
        priority: "high",
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latestState?.workItem).toMatchObject({
      workItemStatus: "in_review",
      priority: "high",
    });
  });

  it("reloads the selected detail when collaboration sync advances its row version", async () => {
    const remoteUpdate = {
      ...WORK_ITEM,
      status: "in_progress",
      workItemStatus: "in_progress",
      priority: "high",
      updated_time: "2026-07-29T09:01:00.000Z",
    };
    mocks.readWorkItem
      .mockResolvedValueOnce(WORK_ITEM)
      .mockResolvedValueOnce(remoteUpdate);

    await act(async () => {
      root.render(
        createElement(Probe, {
          observedUpdatedAt: "2026-07-29T09:00:00.000Z",
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.readWorkItem).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        createElement(Probe, {
          observedUpdatedAt: "2026-07-29T09:01:00.000Z",
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.readWorkItem).toHaveBeenCalledTimes(2);
    expect(latestState?.workItem).toMatchObject({
      workItemStatus: "in_progress",
      priority: "high",
    });
  });

  it("keeps standalone updates inside the owning cloud org", async () => {
    const stored = {
      filename: "AAA-0001.md",
      body: "Body",
      frontmatter: {
        id: "AAA-0001",
        short_id: "AAA-0001",
        title: "Inbox item",
        status: "planned",
        priority: "medium",
        labels: [],
        created_at: "2026-07-28T00:00:00.000Z",
        updated_at: "2026-07-28T00:00:00.000Z",
        starred: false,
        todos: [],
      },
    };
    mocks.readStandaloneWorkItem.mockResolvedValue(stored);

    await act(async () => {
      root.render(createElement(StandaloneProbe));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => {
      latestState?.updateWorkItem({ workItemStatus: "in_review" });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.readStandaloneWorkItem).toHaveBeenCalledWith("AAA-0001", {
      orgId: "cloud-org-1",
    });
    expect(mocks.updateStandaloneWorkItemPartial).toHaveBeenCalledWith(
      "AAA-0001",
      expect.objectContaining({ workItemStatus: "in_review" }),
      { orgId: "cloud-org-1" }
    );
    expect(mocks.updateWorkItemPartial).not.toHaveBeenCalled();
  });

  it("keeps standalone read, update, and handoff identities aligned with the cloud roster", async () => {
    const assigneeId = "f8d2d0c4-ad42-4f02-b000-000000000001";
    const creatorId = "6c6a39b1-4ca5-4c48-89b4-74d1565c258d";
    const stored: WorkItem = {
      ...WORK_ITEM,
      user_id: creatorId,
      assignee: { id: assigneeId, name: assigneeId },
      createdBy: { id: creatorId, name: creatorId },
    };
    mocks.readStandaloneWorkItem.mockResolvedValue(stored);
    mocks.updateStandaloneWorkItemPartial.mockResolvedValue(stored);
    mocks.transitionStandaloneWorkItemHandoff.mockResolvedValue(stored);
    mocks.loadCloudOrgMembers.mockResolvedValue({
      auth: {},
      members: [
        {
          userId: assigneeId,
          displayName: "ahanafish",
          role: "member",
          status: "active",
        },
        {
          userId: creatorId,
          displayName: "1106510024",
          role: "member",
          status: "active",
        },
      ],
    });
    const store = createStore();
    store.set(org2CloudAuthAtom, {
      kind: "org2_cloud",
      supabaseUrl: "https://cloud.example.test",
      supabaseAnonKey: "anon",
      userId: creatorId,
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 4_102_444_800,
    });

    await act(async () => {
      root.render(
        createElement(Provider, { store }, createElement(StandaloneProbe))
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(latestState?.workItem).toMatchObject({
      assignee: { id: assigneeId, name: "ahanafish" },
      createdBy: { id: creatorId, name: "1106510024" },
    });

    act(() => {
      latestState?.updateWorkItem({ priority: "high" });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(latestState?.workItem?.assignee?.name).toBe("ahanafish");

    let transitioned: WorkItem | undefined;
    await act(async () => {
      transitioned = await latestState?.transitionHandoff({
        handoffId: "handoff-1",
        action: "accept",
        actor: {
          id: assigneeId,
          name: "ahanafish",
        },
      });
    });
    expect(transitioned?.assignee?.name).toBe("ahanafish");
  });
});
