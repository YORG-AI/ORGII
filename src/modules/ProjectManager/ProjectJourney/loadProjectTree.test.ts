import { describe, expect, it, vi } from "vitest";

import { loadProjectTreeBundle } from "./loadProjectTree";

const mocks = vi.hoisted(() => ({
  readProjects: vi.fn(),
  readWorkItemsEnriched: vi.fn(),
  readStandaloneWorkItems: vi.fn(),
  sessionAggregateList: vi.fn(),
  toFrontendSession: vi.fn(),
}));

vi.mock("@src/api/http/project", () => ({
  projectApi: {
    readProjects: mocks.readProjects,
    readWorkItemsEnriched: mocks.readWorkItemsEnriched,
    readStandaloneWorkItems: mocks.readStandaloneWorkItems,
  },
  enrichedWorkItemToUI: vi.fn(),
}));

vi.mock("@src/api/tauri/session", () => ({
  sessionAggregateList: mocks.sessionAggregateList,
  toFrontendSession: mocks.toFrontendSession,
}));

describe("loadProjectTreeBundle", () => {
  it("discovers a Project-owned session from the canonical aggregate without a Work Item", async () => {
    mocks.readProjects.mockResolvedValue([
      { meta: { id: "p", name: "项目" }, slug: "project-p" },
    ]);
    mocks.readWorkItemsEnriched.mockResolvedValue([]);
    mocks.readStandaloneWorkItems.mockResolvedValue([]);
    mocks.sessionAggregateList.mockResolvedValue({
      sessions: [{ sessionId: "s" }],
    });
    mocks.toFrontendSession.mockReturnValue({
      session_id: "s",
      name: "实时会话",
      projectId: "p",
    });

    const bundle = await loadProjectTreeBundle();

    expect(mocks.sessionAggregateList).toHaveBeenCalledOnce();
    expect(bundle.tree.children[0]?.children).toMatchObject([
      { kind: "session", sessionId: "s", workItemId: undefined },
    ]);
  });
});
