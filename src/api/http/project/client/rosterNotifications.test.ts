import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectMeta } from "../types";
import { applyCollabRemote } from "./collabSync";
import { writeMembers } from "./members";
import { deleteOrg, syncOrgGitFolder } from "./orgs";
import { deleteProject, moveProject, writeProject } from "./projects";

const mocks = vi.hoisted(() => ({
  notifyProjectRosterChanged: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("../events", () => ({
  notifyProjectRosterChanged: mocks.notifyProjectRosterChanged,
  notifyProjectStatusDefinitionsChanged: vi.fn(),
}));

const PROJECT_META: ProjectMeta = {
  id: "project-1",
  name: "Project One",
  org_id: "org-1",
  status: "active",
  priority: "none",
  health: "no_updates",
  members: [],
  labels: [],
  linked_repos: [],
  created_at: "2026-09-03T00:00:00Z",
  updated_at: "2026-09-03T00:00:00Z",
  next_work_item_id: 1,
  work_item_prefix: "PRO",
  work_item_prefix_custom: false,
};

describe("project roster notifications", () => {
  beforeEach(() => vi.clearAllMocks());

  it("publishes the narrow event from every local roster mutation", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    await writeMembers("project-one", { members: [] });
    await writeProject("project-one", PROJECT_META, "", true);
    await moveProject("project-one", "org-2");
    await deleteProject("project-one");

    expect(mocks.notifyProjectRosterChanged.mock.calls).toEqual([
      [{ project_slug: "project-one", source: "members" }],
      [{ project_slug: "project-one", source: "project" }],
      [{ project_slug: "project-one", source: "project" }],
      [{ project_slug: "project-one", source: "project" }],
    ]);
  });

  it("publishes after a remote project row, but not a Work Item-only pull", async () => {
    mocks.invoke.mockResolvedValue(1);
    await applyCollabRemote({
      orgId: "org-1",
      entities: [{ kind: "work_item", payload: {}, version: 1 }],
    });
    expect(mocks.notifyProjectRosterChanged).not.toHaveBeenCalled();

    await applyCollabRemote({
      orgId: "org-1",
      entities: [{ kind: "project", payload: {}, version: 2 }],
    });
    expect(mocks.notifyProjectRosterChanged).toHaveBeenCalledOnce();
    expect(mocks.notifyProjectRosterChanged).toHaveBeenCalledWith({
      source: "collab",
    });
  });

  it("covers org deletion and only folder syncs that import projects", async () => {
    mocks.invoke.mockResolvedValueOnce(undefined);
    await deleteOrg("org-1");

    const syncResult = {
      org_id: "org-1",
      folder_path: "/tmp/org-1",
      status: "synced" as const,
      conflicts: [],
      projects_exported: 0,
      projects_imported: 0,
      work_items_exported: 1,
      work_items_imported: 1,
    };
    mocks.invoke.mockResolvedValueOnce(syncResult);
    await syncOrgGitFolder({ org_id: "org-1" });
    mocks.invoke.mockResolvedValueOnce({ ...syncResult, projects_imported: 1 });
    await syncOrgGitFolder({ org_id: "org-1" });

    expect(mocks.notifyProjectRosterChanged.mock.calls).toEqual([
      [{ source: "project" }],
      [{ source: "project" }],
    ]);
  });
});
