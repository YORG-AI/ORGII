import { describe, expect, it } from "vitest";

import { projectDataToUI } from "./adapters";
import type { ProjectData } from "./types";

function project(workspaceId?: string): ProjectData {
  return {
    slug: "workspace-project",
    description: "",
    meta: {
      id: "project-1",
      name: "Workspace Project",
      org_id: "personal-org",
      workspace_id: workspaceId,
      status: "active",
      priority: "none",
      health: "no_updates",
      members: [],
      labels: [],
      linked_repos: ["/unrelated/repo"],
      created_at: "2026-08-05T00:00:00Z",
      updated_at: "2026-08-05T00:00:00Z",
      next_work_item_id: 1,
      work_item_prefix: "WSP",
      work_item_prefix_custom: false,
    },
  };
}

describe("projectDataToUI workspace association", () => {
  const context = { labelMap: new Map(), memberMap: new Map() };

  it("preserves an explicit workspace ID", () => {
    expect(
      projectDataToUI(project("workspace-explicit"), context).workspaceId
    ).toBe("workspace-explicit");
  });

  it("keeps legacy projects unlinked even when they have linked repos", () => {
    expect(projectDataToUI(project(), context).workspaceId).toBeUndefined();
  });
});
