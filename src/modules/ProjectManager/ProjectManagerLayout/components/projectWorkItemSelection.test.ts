import { describe, expect, it } from "vitest";

import type { AggregatedWorkItem } from "./ProjectWorkItemsTabContentTypes";
import { toProjectWorkItemSelection } from "./projectWorkItemSelection";

describe("toProjectWorkItemSelection", () => {
  it("uses one mapping for split-pane and dedicated-tab presentation", () => {
    const entry = {
      orgId: "org-1",
      orgName: "Org One",
      shortId: "ONE-7",
      project: {
        meta: { id: "project-1", name: "Project One" },
        slug: "project-one",
      },
      item: { session_id: "item-7", name: "Shared mapping" },
    } as AggregatedWorkItem;

    expect(toProjectWorkItemSelection(entry)).toEqual({
      workItem: entry.item,
      shortId: "ONE-7",
      orgId: "org-1",
      orgName: "Org One",
      projectId: "project-1",
      projectName: "Project One",
      projectSlug: "project-one",
    });
  });
});
