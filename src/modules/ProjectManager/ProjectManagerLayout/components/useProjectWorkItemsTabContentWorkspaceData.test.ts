import { describe, expect, it, vi } from "vitest";

import { projectApi } from "@src/api/http/project";
import type { WorkspaceWorkItemsData } from "@src/api/http/project";

import type { AggregatedWorkItem } from "./ProjectWorkItemsTabContentTypes";
import {
  type ProjectWorkItemsWorkspaceSnapshot,
  loadWorkspaceWorkItemsBucket,
  retainProjectWorkItemsWorkspaceSnapshot,
} from "./useProjectWorkItemsTabContentWorkspaceData";

function item(id: string): AggregatedWorkItem {
  return {
    item: { session_id: id },
    shortId: id,
    orgId: "org-a",
  } as AggregatedWorkItem;
}

describe("retainProjectWorkItemsWorkspaceSnapshot", () => {
  it("preserves the snapshot and row references when data is unchanged", () => {
    const rows = [item("WI-1")];
    const current: ProjectWorkItemsWorkspaceSnapshot = {
      workItemsByProject: rows,
      projectOptions: [],
      loaded: true,
      error: null,
      workspaceSourceMode: "local_only",
      completedItemsLoaded: false,
    };

    const next = retainProjectWorkItemsWorkspaceSnapshot({
      ...current,
      current,
      workItemsByProject: [item("WI-1")],
    });

    expect(next).toBe(current);
    expect(next.workItemsByProject).toBe(rows);
  });

  it("publishes a changed list and bounds retained rows", () => {
    const rows = Array.from({ length: 550 }, (_, index) => item(`WI-${index}`));

    const next = retainProjectWorkItemsWorkspaceSnapshot({
      workItemsByProject: rows,
      projectOptions: [],
      loaded: true,
      error: null,
      workspaceSourceMode: "local_only",
      completedItemsLoaded: false,
    });

    expect(next.workItemsByProject).toHaveLength(500);
    expect(next.workItemsByProject[499]?.shortId).toBe("WI-499");
  });
});

describe("loadWorkspaceWorkItemsBucket", () => {
  it("shares an equivalent in-flight read across rapid remounts", async () => {
    let resolveWorkspace: (value: WorkspaceWorkItemsData) => void = () => {};
    const workspaceRequest = new Promise<WorkspaceWorkItemsData>((resolve) => {
      resolveWorkspace = resolve;
    });
    const readWorkspace = vi.fn(
      (
        _options?: Parameters<typeof projectApi.readWorkspaceWorkItemsData>[0]
      ) => workspaceRequest
    );
    const readLinear = vi.fn(async () => []);
    const options = {
      orgId: "org-a",
      includeExternalSources: false,
    };

    const first = loadWorkspaceWorkItemsBucket(options, {
      readWorkspace,
      readLinear,
    });
    const second = loadWorkspaceWorkItemsBucket(options, {
      readWorkspace,
      readLinear,
    });

    expect(second).toBe(first);
    expect(readWorkspace).toHaveBeenCalledOnce();
    expect(readLinear).not.toHaveBeenCalled();

    resolveWorkspace({} as WorkspaceWorkItemsData);
    await expect(first).resolves.toEqual({
      workspaceData: {},
      linearWorkItems: [],
    });
  });
});
