// @vitest-environment jsdom
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
  updateWorkItemPartial: vi.fn(),
}));

vi.mock("@src/api/http/project", () => ({
  projectApi: {
    readWorkItem: mocks.readWorkItem,
    readProject: mocks.readProject,
    readMembers: mocks.readMembers,
    readStandaloneWorkItem: mocks.readStandaloneWorkItem,
    updateWorkItemPartial: mocks.updateWorkItemPartial,
  },
  standaloneWorkItemDataToEnriched: (value: unknown) => value,
  enrichedWorkItemToUI: (value: unknown) => value,
}));

vi.mock("@src/hooks/project/useCurrentUserMemberId", () => ({
  useCurrentUserMemberIds: () => ({ currentUser: null }),
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

function Probe() {
  const state = useTeamInboxWorkItem({
    kind: "work_item",
    projectId: "demo",
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
    expect(mocks.readProject).not.toHaveBeenCalled();
    expect(mocks.readMembers).not.toHaveBeenCalled();
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
});
