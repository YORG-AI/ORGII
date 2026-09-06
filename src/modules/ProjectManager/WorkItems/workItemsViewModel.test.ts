import { describe, expect, it } from "vitest";

import type {
  PropertyDefinition,
  ScopePropertyValue,
} from "@src/api/http/project";
import type { WorkItem } from "@src/types/core/workItem";

import {
  PROPERTY_FILTER_NONE_VALUE,
  indexScopePropertyValues,
  propertyValueToken,
} from "./propertyViewModel";
import {
  NO_PROJECT_GROUP_KEY,
  WORK_ITEMS_KANBAN_GROUP,
  countWorkItemsByStatus,
  filterWorkItemsBySearchQuery,
  filterWorkItemsByStatus,
  getProjectKanbanColumns,
  getPropertyKanbanColumns,
  groupWorkItemsByProject,
  groupWorkItemsForStatusFilter,
  isDeletedWorkItem,
  workItemToKanbanTask,
  workItemsToKanbanTasks,
  workItemsToPropertyKanbanTasks,
} from "./workItemsViewModel";

function workItem(deletedAt?: string): WorkItem {
  return {
    session_id: "CUT-0001",
    name: "Remote tombstone",
    ...(deletedAt ? { deletedAt } : {}),
  } as WorkItem;
}

describe("isDeletedWorkItem", () => {
  it("treats a retained remote tombstone as unavailable", () => {
    expect(isDeletedWorkItem(workItem("2026-07-21T08:52:03.453Z"))).toBe(true);
  });

  it("keeps a live work item available", () => {
    expect(isDeletedWorkItem(workItem())).toBe(false);
  });
});

describe("filterWorkItemsBySearchQuery", () => {
  const workItems = [
    {
      session_id: "CUT-0001",
      shortId: "CUT-1",
      name: "Fix login authentication",
      project: { id: "project-1", name: "Desktop" },
      assignee: { id: "member-1", name: "Alice" },
      labels: [{ id: "label-1", name: "Security", color: "#ff0000" }],
    },
    {
      session_id: "CUT-0002",
      shortId: "CUT-2",
      name: "Refresh dashboard",
      project: { id: "project-2", name: "Web" },
      labels: [],
    },
  ] as WorkItem[];

  it("shares title, id, project, assignee, and label matching", () => {
    expect(filterWorkItemsBySearchQuery(workItems, "login")).toHaveLength(1);
    expect(filterWorkItemsBySearchQuery(workItems, "cut-2")).toHaveLength(1);
    expect(filterWorkItemsBySearchQuery(workItems, "desktop")).toHaveLength(1);
    expect(filterWorkItemsBySearchQuery(workItems, "alice")).toHaveLength(1);
    expect(filterWorkItemsBySearchQuery(workItems, "security")).toHaveLength(1);
  });

  it("returns the original bounded result set for a blank query", () => {
    expect(filterWorkItemsBySearchQuery(workItems, "   ")).toBe(workItems);
  });
});

describe("custom status category semantics", () => {
  it("folds a non-selectable historical status into its effective group", () => {
    const waiting = {
      ...workItem(),
      status: "waiting_external",
      workItemStatus: "waiting_external",
    } as unknown as WorkItem;

    const groups = groupWorkItemsForStatusFilter(
      [waiting],
      "all",
      [],
      (status) => (status === "waiting_external" ? "blocked" : status)
    );

    expect(groups.find((group) => group.status === "blocked")?.items).toEqual([
      waiting,
    ]);
  });

  it("counts blocked as its own canonical filter bucket", () => {
    const blocked = {
      ...workItem(),
      status: "blocked",
      workItemStatus: "blocked",
    } as WorkItem;

    expect(countWorkItemsByStatus([blocked]).blocked).toBe(1);
  });

  it("uses the effective category for filters and counts", () => {
    const waiting = {
      ...workItem(),
      status: "waiting_external",
      workItemStatus: "waiting_external",
    } as unknown as WorkItem;
    const resolveCategory = (status: string) =>
      status === "waiting_external" ? "blocked" : status;

    expect(
      filterWorkItemsByStatus([waiting], "blocked", resolveCategory)
    ).toEqual([waiting]);
    expect(countWorkItemsByStatus([waiting], resolveCategory).blocked).toBe(1);
  });
});

describe("groupWorkItemsByProject", () => {
  const withProject = (id: string, name: string): WorkItem =>
    ({
      ...workItem(),
      session_id: `id-${id}`,
      project: { id, name },
    }) as WorkItem;

  it("keeps the no-project group present and last even when every item has a project", () => {
    const groups = groupWorkItemsByProject(
      [withProject("p1", "Desktop"), withProject("p2", "Web")],
      "No project"
    );
    expect(groups.map((group) => group.key)).toEqual([
      "project:p1",
      "project:p2",
      NO_PROJECT_GROUP_KEY,
    ]);
    expect(groups.at(-1)).toMatchObject({
      key: NO_PROJECT_GROUP_KEY,
      label: "No project",
      items: [],
    });
  });

  it("buckets items without a project into the persistent no-project group", () => {
    const noProject = workItem();
    const groups = groupWorkItemsByProject(
      [withProject("p1", "Desktop"), noProject],
      "No project"
    );
    const bucket = groups.find((group) => group.key === NO_PROJECT_GROUP_KEY);
    expect(bucket?.items).toEqual([noProject]);
  });

  it("sorts real projects alphabetically ahead of the no-project group", () => {
    const groups = groupWorkItemsByProject(
      [withProject("p2", "Web"), withProject("p1", "Desktop")],
      "No project"
    );
    expect(groups.map((group) => group.label)).toEqual([
      "Desktop",
      "Web",
      "No project",
    ]);
  });
});

describe("Kanban project grouping", () => {
  const withProject = (id: string, name: string): WorkItem =>
    ({
      ...workItem(),
      session_id: `id-${id}`,
      project: { id, name },
    }) as WorkItem;

  it("renders a persistent No project Kanban column even when it is empty", () => {
    const columns = getProjectKanbanColumns(
      [withProject("p1", "Desktop")],
      "No project"
    );
    expect(columns.map((column) => column.id)).toEqual([
      "project:p1",
      NO_PROJECT_GROUP_KEY,
    ]);
    expect(columns.at(-1)?.title).toBe("No project");
  });

  it("assigns each item's Kanban task to its project column", () => {
    const inProject = withProject("p1", "Desktop");
    const noProject = workItem();
    expect(
      workItemToKanbanTask(inProject, WORK_ITEMS_KANBAN_GROUP.PROJECT).status
    ).toBe("project:p1");
    expect(
      workItemToKanbanTask(noProject, WORK_ITEMS_KANBAN_GROUP.PROJECT).status
    ).toBe(NO_PROJECT_GROUP_KEY);
  });

  it("excludes deleted items from the generated Kanban tasks", () => {
    const deleted = {
      ...withProject("p1", "Desktop"),
      deletedAt: "2026-08-21T00:00:00Z",
    } as WorkItem;
    expect(
      workItemsToKanbanTasks(
        [withProject("p1", "Desktop"), deleted],
        WORK_ITEMS_KANBAN_GROUP.PROJECT
      )
    ).toHaveLength(1);
  });
});

describe("Kanban property grouping", () => {
  const definition: PropertyDefinition = {
    id: "risk",
    orgId: "org-1",
    name: "Risk",
    propertyType: "select",
    description: "",
    config: {
      options: [
        { id: "low", name: "Low" },
        { id: "high", name: "High" },
      ],
    },
    position: 0,
    createdAt: "2026-08-19T00:00:00Z",
    updatedAt: "2026-08-19T00:00:00Z",
  };

  const items = [
    { ...workItem(), session_id: "id-1", shortId: "WI-1" },
    { ...workItem(), session_id: "id-2", shortId: "WI-2" },
  ] as WorkItem[];

  const values: ScopePropertyValue[] = [
    { propertyId: definition.id, workItemId: "WI-1", value: "high" },
  ];

  it("reuses the Table property-grouping model to build Kanban columns", () => {
    const valuesByItem = indexScopePropertyValues(values);
    const columns = getPropertyKanbanColumns(
      items,
      definition,
      valuesByItem,
      [],
      "No value"
    );
    expect(columns.map((column) => column.title)).toEqual(["High", "No value"]);
  });

  it("assigns each item's Kanban task to its property-value column", () => {
    const valuesByItem = indexScopePropertyValues(values);
    const tasks = workItemsToPropertyKanbanTasks(
      items,
      definition,
      valuesByItem,
      []
    );
    const byId = new Map(tasks.map((task) => [task.id, task.status]));
    expect(byId.get("id-1")).toBe(`property:${propertyValueToken("high")}`);
    expect(byId.get("id-2")).toBe(`property:${PROPERTY_FILTER_NONE_VALUE}`);
  });
});
