import { describe, expect, it, vi } from "vitest";

import {
  loadProjectTreeBundle,
  loadSessionJourneys,
  streamSessionJourneys,
} from "./loadProjectTree";

const mocks = vi.hoisted(() => ({
  readProjects: vi.fn(),
  readWorkItemsEnriched: vi.fn(),
  readStandaloneWorkItems: vi.fn(),
  sessionAggregateList: vi.fn(),
  toFrontendSession: vi.fn(),
  snapshot: vi.fn(),
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

vi.mock("@src/api/tauri/sessionJourney", () => ({
  sessionJourneyApi: { snapshot: mocks.snapshot },
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
      {
        kind: "session",
        sessionId: "s",
        workItemId: undefined,
        children: [],
      },
    ]);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it("preserves snapshot failures as explicit unavailable state", async () => {
    mocks.snapshot.mockRejectedValueOnce(new Error("not a Journey session"));

    await expect(
      loadSessionJourneys([{ session_id: "missing" }])
    ).resolves.toEqual(
      new Map([
        ["missing", { state: "unavailable", error: "not a Journey session" }],
      ])
    );
  });

  it("bounds mixed snapshot requests while retaining every canonical session result", async () => {
    let active = 0;
    let peak = 0;
    mocks.snapshot.mockClear();
    mocks.snapshot.mockImplementation(async (sessionId: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      if (sessionId === "s-7") throw new Error("snapshot failed");
      return { snapshot: { tasks: {}, checkpoints: {}, branches: {} } };
    });

    const sessions = Array.from({ length: 8 }, (_, index) => ({
      session_id: `s-${index}`,
    }));
    const result = await loadSessionJourneys(sessions);

    expect(mocks.snapshot).toHaveBeenCalledTimes(8);
    expect(peak).toBeLessThanOrEqual(6);
    expect(result.size).toBe(8);
    expect(result.get("s-7")).toMatchObject({ state: "unavailable" });
  });

  it("streams each session result without delaying canonical tree loading", async () => {
    mocks.snapshot.mockClear();
    const pending = new Map<string, (value: unknown) => void>();
    mocks.snapshot.mockImplementation(
      (sessionId: string) =>
        new Promise((resolve) => pending.set(sessionId, resolve))
    );
    const results: string[] = [];
    const stream = streamSessionJourneys(
      [{ session_id: "one" }, { session_id: "two" }],
      (sessionId) => results.push(sessionId),
      1
    );
    expect(mocks.snapshot).toHaveBeenCalledWith("one");
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    pending.get("one")?.({ snapshot: { tasks: {}, branches: {} } });
    await Promise.resolve();
    expect(mocks.snapshot).toHaveBeenCalledWith("two");
    pending.get("two")?.({ snapshot: { tasks: {}, branches: {} } });
    await stream;
    expect(results).toEqual(["one", "two"]);
  });
});
