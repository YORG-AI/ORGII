import { beforeEach, describe, expect, it, vi } from "vitest";

import { readWorkspaceWorkItemsData } from "./client";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("project client", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("normalizes omitted standalone todo arrays at the IPC boundary", async () => {
    invokeMock.mockResolvedValue({
      projectEntries: [],
      standaloneWorkItems: [
        {
          orgId: "personal-org",
          workItem: {
            body: "",
            filename: "WI-1",
            frontmatter: {
              id: "work-1",
              short_id: "WI-1",
              title: "No todos",
              status: "planned",
              priority: "none",
              labels: [],
              starred: false,
              created_at: "2026-08-13T00:00:00Z",
              updated_at: "2026-08-13T00:00:00Z",
            },
          },
        },
      ],
      orgs: [],
    });

    const data = await readWorkspaceWorkItemsData({ readBucket: "active" });

    expect(data.standaloneWorkItems[0]?.workItem.frontmatter.todos).toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith(
      "project_read_workspace_work_items_data",
      expect.objectContaining({ readBucket: "active" })
    );
  });
});
