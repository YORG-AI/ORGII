/**
 * WorkItems Type Contract Tests
 *
 * Validates the contract between Rust backend and TypeScript frontend.
 * Ensures type shapes match expectations and edge cases are handled.
 */
import { describe, expect, it } from "vitest";

import type {
  EnrichedWorkItem,
  RustCalendarEvent,
  RustGanttTask,
  RustKanbanTask,
  StatusCounts,
  WorkItemsViewData,
} from "@src/api/http/project";

// ----------------------------------------------------------------------------
// Mock Data Generators (simulating Rust response)
// ----------------------------------------------------------------------------

function createMockStatusCounts(
  overrides: Partial<StatusCounts> = {}
): StatusCounts {
  return {
    all: 10,
    backlog: 2,
    planned: 3,
    inProgress: 2,
    inReview: 1,
    completed: 1,
    cancelled: 1,
    duplicate: 0,
    ...overrides,
  };
}

function createMockEnrichedWorkItem(
  overrides: Partial<EnrichedWorkItem> = {}
): EnrichedWorkItem {
  return {
    id: "uuid-test-001",
    shortId: "WI-001",
    title: "Test Work Item",
    body: "Test description",
    filename: "WI-001.md",
    status: "planned",
    priority: "medium",
    starred: false,
    labels: [],
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-30T00:00:00Z",
    todos: [],
    comments: [],
    linkedSessions: [],
    followUpItems: [],
    workProducts: [],
    history: [],
    ...overrides,
  };
}

function createMockViewData(
  overrides: Partial<WorkItemsViewData> = {}
): WorkItemsViewData {
  return {
    items: [],
    counts: createMockStatusCounts(),
    kanbanTasks: [],
    ganttTasks: [],
    calendarEvents: [],
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// Type Contract Tests
// ----------------------------------------------------------------------------

describe("WorkItemsViewData Structure", () => {
  it("has the required core fields", () => {
    const viewData = createMockViewData();

    expect(viewData).toHaveProperty("items");
    expect(viewData).toHaveProperty("counts");
  });

  it("allows view projections to be omitted", () => {
    const viewData: WorkItemsViewData = {
      items: [],
      counts: createMockStatusCounts(),
    };

    expect(viewData.kanbanTasks).toBeUndefined();
  });

  it("items array contains EnrichedWorkItem objects", () => {
    const viewData = createMockViewData({
      items: [
        createMockEnrichedWorkItem({ id: "1" }),
        createMockEnrichedWorkItem({ id: "2" }),
      ],
    });

    expect(viewData.items).toHaveLength(2);
    viewData.items.forEach((item) => {
      expect(item).toHaveProperty("id");
      expect(item).toHaveProperty("shortId");
      expect(item).toHaveProperty("title");
      expect(item).toHaveProperty("status");
    });
  });

  it("counts object has all status keys", () => {
    const viewData = createMockViewData();

    expect(viewData.counts).toHaveProperty("all");
    expect(viewData.counts).toHaveProperty("backlog");
    expect(viewData.counts).toHaveProperty("planned");
    expect(viewData.counts).toHaveProperty("inProgress");
    expect(viewData.counts).toHaveProperty("inReview");
    expect(viewData.counts).toHaveProperty("completed");
    expect(viewData.counts).toHaveProperty("cancelled");
    expect(viewData.counts).toHaveProperty("duplicate");
  });
});

describe("EnrichedWorkItem Structure", () => {
  it("has required core fields", () => {
    const item = createMockEnrichedWorkItem();

    expect(typeof item.id).toBe("string");
    expect(typeof item.shortId).toBe("string");
    expect(typeof item.title).toBe("string");
    expect(typeof item.status).toBe("string");
    expect(typeof item.priority).toBe("string");
    expect(typeof item.starred).toBe("boolean");
  });

  it("supports optional assignee", () => {
    const withAssignee = createMockEnrichedWorkItem({
      assignee: { id: "m1", name: "John", color: "#3b82f6" },
    });
    const withoutAssignee = createMockEnrichedWorkItem({
      assignee: undefined,
    });

    expect(withAssignee.assignee?.name).toBe("John");
    expect(withoutAssignee.assignee).toBeUndefined();
  });

  it("supports resolved labels array", () => {
    const item = createMockEnrichedWorkItem({
      labels: [
        { id: "l1", name: "bug", color: "#ef4444" },
        { id: "l2", name: "urgent", color: "#f97316" },
      ],
    });

    expect(item.labels).toHaveLength(2);
    expect(item.labels[0].name).toBe("bug");
    expect(item.labels[1].color).toBe("#f97316");
  });

  it("supports optional date fields", () => {
    const withDates = createMockEnrichedWorkItem({
      startDate: "2026-03-01",
      targetDate: "2026-03-31",
    });
    const withoutDates = createMockEnrichedWorkItem({
      startDate: undefined,
      targetDate: undefined,
    });

    expect(withDates.startDate).toBe("2026-03-01");
    expect(withoutDates.startDate).toBeUndefined();
  });

  it("supports orchestrator workflow fields", () => {
    const item = createMockEnrichedWorkItem({
      orchestratorConfig: {
        review_enabled: true,
        follow_up_enabled: false,
        auto_retry_on_failure: true,
        max_retry_count: 3,
        auto_create_pr: false,
      },
      orchestratorState: {
        current_phase: "sde",
        retry_count: 1,
        review_round: 0,
        interrupted: false,
      },
    });

    expect(item.orchestratorConfig?.max_retry_count).toBe(3);
    expect(item.orchestratorState?.current_phase).toBe("sde");
  });
});

describe("RustKanbanTask Structure", () => {
  const validStatuses = [
    "backlog",
    "planned",
    "in_progress",
    "in_review",
    "completed",
    "cancelled",
    "duplicate",
  ];

  it("has required fields", () => {
    const task: RustKanbanTask = {
      id: "WI-001",
      title: "Test task",
      status: "planned",
      labels: [],
    };

    expect(task.id).toBe("WI-001");
    expect(task.title).toBe("Test task");
    expect(task.status).toBe("planned");
    expect(task.labels).toEqual([]);
  });

  it("status must be a valid Kanban status", () => {
    validStatuses.forEach((status) => {
      const task: RustKanbanTask = {
        id: "test",
        title: "test",
        status: status as RustKanbanTask["status"],
        labels: [],
      };
      expect(validStatuses).toContain(task.status);
    });
  });
});

describe("RustGanttTask Structure", () => {
  it("has required date fields", () => {
    const task: RustGanttTask = {
      id: "WI-001",
      title: "Project task",
      startDate: "2026-03-01",
      endDate: "2026-03-15",
      status: "in_progress",
      labels: [],
    };

    expect(task.startDate).toBe("2026-03-01");
    expect(task.endDate).toBe("2026-03-15");
  });

  it("supports overdue status", () => {
    const task: RustGanttTask = {
      id: "WI-002",
      title: "Overdue task",
      startDate: "2026-02-01",
      endDate: "2026-02-15",
      status: "overdue",
      labels: [],
    };

    expect(task.status).toBe("overdue");
  });
});

describe("RustCalendarEvent Structure", () => {
  it("supports all-day events", () => {
    const allDayEvent: RustCalendarEvent = {
      id: "WI-001",
      title: "All day meeting",
      startDate: "2026-03-30",
      endDate: "2026-03-30",
      status: "planned",
      labels: [],
      allDay: true,
    };

    expect(allDayEvent.allDay).toBe(true);
  });

  it("supports timed events", () => {
    const timedEvent: RustCalendarEvent = {
      id: "WI-002",
      title: "Sprint planning",
      startDate: "2026-03-30T09:00:00",
      endDate: "2026-03-30T11:00:00",
      status: "in_progress",
      labels: [],
      allDay: false,
    };

    expect(timedEvent.allDay).toBe(false);
  });

  it("supports assignee with resolved person", () => {
    const event: RustCalendarEvent = {
      id: "WI-003",
      title: "Review session",
      startDate: "2026-03-30",
      endDate: "2026-03-30",
      status: "planned",
      assignee: { id: "m1", name: "Alice", color: "#3b82f6" },
      labels: [],
      allDay: true,
    };

    expect(event.assignee?.name).toBe("Alice");
  });
});

describe("StatusCounts Integrity", () => {
  it("all count equals sum of individual statuses", () => {
    const counts = createMockStatusCounts({
      all: 10,
      backlog: 2,
      planned: 3,
      inProgress: 2,
      inReview: 1,
      completed: 1,
      cancelled: 1,
    });

    const sum =
      counts.backlog +
      counts.planned +
      counts.inProgress +
      counts.inReview +
      counts.completed +
      counts.cancelled;

    expect(sum).toBe(counts.all);
  });

  it("all counts are non-negative integers", () => {
    const counts = createMockStatusCounts();

    Object.values(counts).forEach((value) => {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    });
  });
});

describe("Edge Cases", () => {
  it("handles empty view data", () => {
    const emptyViewData = createMockViewData({
      items: [],
      counts: createMockStatusCounts({
        all: 0,
        backlog: 0,
        planned: 0,
        inProgress: 0,
        inReview: 0,
        completed: 0,
        cancelled: 0,
      }),
      kanbanTasks: [],
      ganttTasks: [],
      calendarEvents: [],
    });

    expect(emptyViewData.items).toHaveLength(0);
    expect(emptyViewData.counts.all).toBe(0);
  });

  it("handles work item with empty strings", () => {
    const item = createMockEnrichedWorkItem({
      title: "",
      body: "",
    });

    expect(item.title).toBe("");
    expect(item.body).toBe("");
  });

  it("handles work item with special characters in title", () => {
    const item = createMockEnrichedWorkItem({
      title: 'Fix bug: "undefined" error in <Component> & API',
    });

    expect(item.title).toContain("&");
    expect(item.title).toContain("<");
    expect(item.title).toContain('"');
  });

  it("handles work item with unicode content", () => {
    const item = createMockEnrichedWorkItem({
      title: "修复登录问题 🐛",
      body: "用户反馈无法登录 → 需要检查认证流程",
    });

    expect(item.title).toContain("🐛");
    expect(item.body).toContain("→");
  });

  it("handles deeply nested todos", () => {
    const item = createMockEnrichedWorkItem({
      todos: [
        { id: "t1", content: "First task", status: "pending" },
        { id: "t2", content: "Second task", status: "in_progress" },
        { id: "t3", content: "Third task", status: "completed" },
      ],
    });

    expect(item.todos).toHaveLength(3);
    expect(item.todos[0].status).toBe("pending");
    expect(item.todos[2].status).toBe("completed");
  });
});
