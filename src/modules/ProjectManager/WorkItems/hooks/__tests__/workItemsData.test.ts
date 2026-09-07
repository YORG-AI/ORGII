/**
 * WorkItems Data Hook Tests
 *
 * Tests for:
 * 1. Rust → Frontend type converters
 * 2. Status filter mapping
 * 3. Status counts transformation (Rust "planned/completed" → Frontend "todo/done")
 * 4. Overview stats computation
 */
import { describe, expect, it } from "vitest";

import type {
  EnrichedWorkItem,
  ResolvedLabel,
  ResolvedPerson,
  RustCalendarEvent,
  RustGanttTask,
  RustKanbanTask,
  StatusCounts,
  WorkItemsViewData,
} from "@src/api/http/project";

import { FILTER_TO_STATUS, type StatusFilterType } from "../../types";
import { mergeWorkItemsViewDataByRevision } from "../useWorkItemsData";

// ============================================
// Rust → Frontend Type Converters (mirrored from useWorkItemsData)
// ============================================

function rustKanbanToFrontend(task: RustKanbanTask) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    assignee: task.assignee,
    labels: task.labels,
  };
}

function rustGanttToFrontend(task: RustGanttTask) {
  return {
    id: task.id,
    title: task.title,
    startDate: task.startDate,
    endDate: task.endDate,
    status: task.status,
    assignee: task.assignee,
    labels: task.labels,
  };
}

function rustCalendarToFrontend(event: RustCalendarEvent) {
  return {
    id: event.id,
    title: event.title,
    startDate: event.startDate,
    endDate: event.endDate,
    status: event.status,
    assignee: event.assignee,
    labels: event.labels,
    allDay: event.allDay,
  };
}

// Status counts transformation (Rust keys → Frontend keys)
function transformStatusCounts(rustCounts: StatusCounts) {
  return {
    all: rustCounts.all,
    backlog: rustCounts.backlog,
    todo: rustCounts.planned, // Rust: "planned" → Frontend: "todo"
    inProgress: rustCounts.inProgress,
    inReview: rustCounts.inReview,
    blocked: rustCounts.blocked,
    done: rustCounts.completed,
    cancelled: rustCounts.cancelled,
    duplicate: rustCounts.duplicate,
  };
}

// Overview stats computation
function computeOverviewStats(statusCounts: {
  all: number;
  done: number;
  inProgress: number;
}) {
  const total = statusCounts.all;
  const inProgress = statusCounts.inProgress;
  const completed = statusCounts.done;
  const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
  return { total, inProgress, completed, completionRate };
}

// ============================================
// Test Fixtures
// ============================================

const mockLabel: ResolvedLabel = {
  id: "label-1",
  name: "bug",
  color: "#ff0000",
};

const mockPerson: ResolvedPerson = {
  id: "member-1",
  name: "John Doe",
  color: "#3b82f6",
};

const mockKanbanTask: RustKanbanTask = {
  id: "WI-001",
  title: "Fix login bug",
  description: "Users cannot login with SSO",
  status: "in_progress",
  priority: "high",
  assignee: "John Doe",
  labels: [mockLabel],
};

const mockGanttTask: RustGanttTask = {
  id: "WI-002",
  title: "Implement dashboard",
  startDate: "2026-03-01",
  endDate: "2026-03-15",
  status: "in_progress",
  assignee: "Jane Smith",
  labels: [mockLabel],
};

const mockCalendarEvent: RustCalendarEvent = {
  id: "WI-003",
  title: "Code review meeting",
  startDate: "2026-03-30",
  endDate: "2026-03-30",
  status: "planned",
  assignee: mockPerson,
  labels: [],
  allDay: true,
};

const mockRustStatusCounts: StatusCounts = {
  all: 25,
  backlog: 5,
  planned: 8, // Rust uses "planned"
  inProgress: 6,
  inReview: 2,
  blocked: 0,
  completed: 3,
  cancelled: 1,
  duplicate: 0,
};

const mockEnrichedWorkItem: EnrichedWorkItem = {
  id: "uuid-001",
  revision: 1,
  shortId: "WI-001",
  title: "Test work item",
  body: "Description of the work item",
  filename: "WI-001.md",
  status: "in_progress",
  priority: "medium",
  starred: false,
  assignee: mockPerson,
  labels: [mockLabel],
  createdAt: "2026-03-01T10:00:00Z",
  updatedAt: "2026-03-30T08:00:00Z",
  todos: [],
  comments: [],
  linkedSessions: [],
  followUpItems: [],
  workProducts: [],
  history: [],
};

describe("Work item revision merging", () => {
  const viewData = (
    item: EnrichedWorkItem,
    overrides: Partial<WorkItemsViewData> = {}
  ): WorkItemsViewData => ({
    items: [item],
    counts: mockRustStatusCounts,
    ...overrides,
  });

  it("keeps a newer local row when an older refresh resolves later", () => {
    const current = viewData(
      {
        ...mockEnrichedWorkItem,
        revision: 4,
        title: "Newer title",
      },
      {
        kanbanTasks: [
          {
            ...mockKanbanTask,
            id: mockEnrichedWorkItem.id,
            title: "Newer title",
          },
        ],
      }
    );

    const merged = mergeWorkItemsViewDataByRevision(
      current,
      viewData(
        {
          ...mockEnrichedWorkItem,
          revision: 3,
          title: "Stale title",
        },
        {
          kanbanTasks: [
            {
              ...mockKanbanTask,
              id: mockEnrichedWorkItem.id,
              title: "Stale title",
            },
          ],
        }
      )
    );

    expect(merged.items[0]).toMatchObject({
      revision: 4,
      title: "Newer title",
    });
    expect(merged.kanbanTasks?.[0].title).toBe("Newer title");
  });

  it("keeps every projection aligned with the protected newer row", () => {
    const current = viewData(
      {
        ...mockEnrichedWorkItem,
        revision: 9,
        title: "Protected title",
      },
      {
        kanbanTasks: [
          {
            ...mockKanbanTask,
            id: mockEnrichedWorkItem.id,
            title: "Protected title",
          },
        ],
        ganttTasks: [
          {
            ...mockGanttTask,
            id: mockEnrichedWorkItem.id,
            title: "Protected title",
          },
        ],
        calendarEvents: [
          {
            ...mockCalendarEvent,
            id: mockEnrichedWorkItem.id,
            title: "Protected title",
          },
        ],
      }
    );
    const staleTitle = "Late stale title";
    const merged = mergeWorkItemsViewDataByRevision(
      current,
      viewData(
        {
          ...mockEnrichedWorkItem,
          revision: 8,
          title: staleTitle,
        },
        {
          kanbanTasks: [
            {
              ...mockKanbanTask,
              id: mockEnrichedWorkItem.id,
              title: staleTitle,
            },
          ],
          ganttTasks: [
            {
              ...mockGanttTask,
              id: mockEnrichedWorkItem.id,
              title: staleTitle,
            },
          ],
          calendarEvents: [
            {
              ...mockCalendarEvent,
              id: mockEnrichedWorkItem.id,
              title: staleTitle,
            },
          ],
        }
      )
    );

    expect(merged.items[0].title).toBe("Protected title");
    expect(merged.kanbanTasks?.[0].title).toBe("Protected title");
    expect(merged.ganttTasks?.[0].title).toBe("Protected title");
    expect(merged.calendarEvents?.[0].title).toBe("Protected title");
  });

  it("does not resurrect a row omitted by the authoritative query", () => {
    const current = viewData({
      ...mockEnrichedWorkItem,
      revision: 9,
      title: "No longer in this filtered result",
    });
    const incoming: WorkItemsViewData = {
      items: [],
      counts: { ...mockRustStatusCounts, all: 0 },
      kanbanTasks: [],
    };

    const merged = mergeWorkItemsViewDataByRevision(current, incoming);

    expect(merged.items).toEqual([]);
    expect(merged.kanbanTasks).toEqual([]);
  });

  it("accepts an authoritative refresh with an equal or newer revision", () => {
    const current = viewData({
      ...mockEnrichedWorkItem,
      revision: 4,
      title: "Current title",
    });

    const merged = mergeWorkItemsViewDataByRevision(
      current,
      viewData({
        ...mockEnrichedWorkItem,
        revision: 5,
        title: "Authoritative title",
      })
    );

    expect(merged.items[0]).toMatchObject({
      revision: 5,
      title: "Authoritative title",
    });
  });
});

// ============================================
// Tests
// ============================================

describe("WorkItems Data Transformers", () => {
  describe("rustKanbanToFrontend", () => {
    it("converts Kanban task correctly", () => {
      const result = rustKanbanToFrontend(mockKanbanTask);

      expect(result.id).toBe("WI-001");
      expect(result.title).toBe("Fix login bug");
      expect(result.status).toBe("in_progress");
      expect(result.priority).toBe("high");
      expect(result.labels).toHaveLength(1);
      expect(result.labels[0].name).toBe("bug");
    });

    it("handles optional fields", () => {
      const minimalTask: RustKanbanTask = {
        id: "WI-004",
        title: "Minimal task",
        status: "planned",
        labels: [],
      };

      const result = rustKanbanToFrontend(minimalTask);

      expect(result.description).toBeUndefined();
      expect(result.priority).toBeUndefined();
      expect(result.assignee).toBeUndefined();
    });
  });

  describe("rustGanttToFrontend", () => {
    it("converts Gantt task correctly", () => {
      const result = rustGanttToFrontend(mockGanttTask);

      expect(result.id).toBe("WI-002");
      expect(result.title).toBe("Implement dashboard");
      expect(result.startDate).toBe("2026-03-01");
      expect(result.endDate).toBe("2026-03-15");
      expect(result.status).toBe("in_progress");
    });
  });

  describe("rustCalendarToFrontend", () => {
    it("converts calendar event correctly", () => {
      const result = rustCalendarToFrontend(mockCalendarEvent);

      expect(result.id).toBe("WI-003");
      expect(result.title).toBe("Code review meeting");
      expect(result.allDay).toBe(true);
      expect(result.assignee?.name).toBe("John Doe");
    });
  });
});

describe("Status Filter Mapping", () => {
  it("maps 'all' filter to null (no status filtering)", () => {
    expect(FILTER_TO_STATUS.all).toBeNull();
  });

  it("maps frontend filter names to backend status values", () => {
    expect(FILTER_TO_STATUS.todo).toBe("planned");
    expect(FILTER_TO_STATUS.done).toBe("completed");
    expect(FILTER_TO_STATUS.backlog).toBe("backlog");
    expect(FILTER_TO_STATUS.inProgress).toBe("in_progress");
    expect(FILTER_TO_STATUS.inReview).toBe("in_review");
    expect(FILTER_TO_STATUS.blocked).toBe("blocked");
    expect(FILTER_TO_STATUS.cancelled).toBe("cancelled");
    expect(FILTER_TO_STATUS.duplicate).toBe("duplicate");
  });

  it("covers all StatusFilterType values", () => {
    const allFilters: StatusFilterType[] = [
      "all",
      "backlog",
      "todo",
      "inProgress",
      "inReview",
      "blocked",
      "done",
      "cancelled",
      "duplicate",
    ];

    allFilters.forEach((filter) => {
      expect(FILTER_TO_STATUS).toHaveProperty(filter);
    });
  });
});

describe("Status Counts Transformation", () => {
  it("transforms Rust status counts to frontend format", () => {
    const result = transformStatusCounts(mockRustStatusCounts);

    expect(result.all).toBe(25);
    expect(result.backlog).toBe(5);
    expect(result.todo).toBe(8); // Was "planned" in Rust
    expect(result.inProgress).toBe(6);
    expect(result.inReview).toBe(2);
    expect(result.blocked).toBe(0);
    expect(result.done).toBe(3); // Was "completed" in Rust
    expect(result.cancelled).toBe(1);
    expect(result.duplicate).toBe(0);
  });

  it("handles zero counts", () => {
    const zeroCounts: StatusCounts = {
      all: 0,
      backlog: 0,
      planned: 0,
      inProgress: 0,
      inReview: 0,
      blocked: 0,
      completed: 0,
      cancelled: 0,
      duplicate: 0,
    };

    const result = transformStatusCounts(zeroCounts);

    expect(result.all).toBe(0);
    expect(result.todo).toBe(0);
    expect(result.done).toBe(0);
  });

  it("preserves total count integrity", () => {
    const result = transformStatusCounts(mockRustStatusCounts);

    // Sum of individual statuses should equal total
    const sum =
      result.backlog +
      result.todo +
      result.inProgress +
      result.inReview +
      result.blocked +
      result.done +
      result.cancelled;

    expect(sum).toBe(result.all);
  });
});

describe("Overview Stats Computation", () => {
  it("computes stats correctly from status counts", () => {
    const statusCounts = {
      all: 25,
      done: 10,
      inProgress: 5,
    };

    const result = computeOverviewStats(statusCounts);

    expect(result.total).toBe(25);
    expect(result.completed).toBe(10);
    expect(result.inProgress).toBe(5);
    expect(result.completionRate).toBe(40); // 10/25 = 40%
  });

  it("handles empty project (zero items)", () => {
    const statusCounts = {
      all: 0,
      done: 0,
      inProgress: 0,
    };

    const result = computeOverviewStats(statusCounts);

    expect(result.total).toBe(0);
    expect(result.completed).toBe(0);
    expect(result.completionRate).toBe(0); // Avoid division by zero
  });

  it("rounds completion rate to integer", () => {
    const statusCounts = {
      all: 3,
      done: 1,
      inProgress: 1,
    };

    const result = computeOverviewStats(statusCounts);

    // 1/3 = 33.33...% → rounds to 33
    expect(result.completionRate).toBe(33);
  });

  it("handles 100% completion", () => {
    const statusCounts = {
      all: 10,
      done: 10,
      inProgress: 0,
    };

    const result = computeOverviewStats(statusCounts);

    expect(result.completionRate).toBe(100);
  });
});

describe("Work Item Filtering Logic", () => {
  const workItems: EnrichedWorkItem[] = [
    { ...mockEnrichedWorkItem, id: "1", status: "backlog" },
    { ...mockEnrichedWorkItem, id: "2", status: "planned" },
    { ...mockEnrichedWorkItem, id: "3", status: "in_progress" },
    { ...mockEnrichedWorkItem, id: "4", status: "completed" },
    { ...mockEnrichedWorkItem, id: "5", status: "cancelled" },
  ];

  function filterByStatus(
    items: EnrichedWorkItem[],
    filter: StatusFilterType
  ): EnrichedWorkItem[] {
    if (filter === "all") return items;

    const targetStatus = FILTER_TO_STATUS[filter];
    return items.filter((item) => item.status === targetStatus);
  }

  it("returns all items when filter is 'all'", () => {
    const result = filterByStatus(workItems, "all");
    expect(result).toHaveLength(5);
  });

  it("filters 'todo' items (status: planned)", () => {
    const result = filterByStatus(workItems, "todo");
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("planned");
  });

  it("filters 'done' items (status: completed)", () => {
    const result = filterByStatus(workItems, "done");
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("completed");
  });

  it("filters 'inProgress' items", () => {
    const result = filterByStatus(workItems, "inProgress");
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("in_progress");
  });
});

describe("Search Filtering Logic", () => {
  const workItems: EnrichedWorkItem[] = [
    {
      ...mockEnrichedWorkItem,
      id: "1",
      title: "Fix login authentication",
      labels: [{ id: "l1", name: "auth", color: "#f00" }],
      assignee: { id: "m1", name: "Alice", color: "#00f" },
    },
    {
      ...mockEnrichedWorkItem,
      id: "2",
      title: "Implement dashboard widgets",
      labels: [{ id: "l2", name: "ui", color: "#0f0" }],
      assignee: { id: "m2", name: "Bob", color: "#0ff" },
    },
    {
      ...mockEnrichedWorkItem,
      id: "3",
      title: "Database migration script",
      labels: [],
      assignee: undefined,
    },
  ];

  function searchWorkItems(
    items: EnrichedWorkItem[],
    query: string
  ): EnrichedWorkItem[] {
    if (!query.trim()) return items;

    const search = query.toLowerCase();
    return items.filter((item) => {
      const title = item.title?.toLowerCase() || "";
      const labels =
        item.labels?.map((l) => l.name.toLowerCase()).join(" ") || "";
      const assignee = item.assignee?.name?.toLowerCase() || "";

      return (
        title.includes(search) ||
        labels.includes(search) ||
        assignee.includes(search)
      );
    });
  }

  it("returns all items when search query is empty", () => {
    expect(searchWorkItems(workItems, "")).toHaveLength(3);
    expect(searchWorkItems(workItems, "   ")).toHaveLength(3);
  });

  it("searches by title", () => {
    const result = searchWorkItems(workItems, "login");
    expect(result).toHaveLength(1);
    expect(result[0].title).toContain("login");
  });

  it("searches by label name", () => {
    const result = searchWorkItems(workItems, "ui");
    expect(result).toHaveLength(1);
    expect(result[0].labels[0].name).toBe("ui");
  });

  it("searches by assignee name", () => {
    const result = searchWorkItems(workItems, "alice");
    expect(result).toHaveLength(1);
    expect(result[0].assignee?.name).toBe("Alice");
  });

  it("search is case-insensitive", () => {
    expect(searchWorkItems(workItems, "LOGIN")).toHaveLength(1);
    expect(searchWorkItems(workItems, "ALICE")).toHaveLength(1);
  });

  it("handles items without assignee", () => {
    const result = searchWorkItems(workItems, "migration");
    expect(result).toHaveLength(1);
    expect(result[0].assignee).toBeUndefined();
  });
});
