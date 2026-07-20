/**
 * Unit tests for the pure helpers backing `useTodoSync`.
 *
 * Coverage:
 *   - `normalizePersistedTodo`: id fallback, content fallback,
 *     activeForm filtering, status fallback, blockedBy filtering.
 *   - `normalizePersistedTodoList`: empty / null / non-array
 *     defenses, position-stable ids, end-to-end shape match.
 *   - `isManageTodoEvent`: matches by functionName, by actionType,
 *     and returns false for unrelated events.
 *
 * The hook orchestration (atom writes, session-switch refs) is not
 * directly testable without a React renderer + jotai store, but the
 * pure transforms above contain the bulk of the logic that has
 * historically had off-by-one / null-leak bugs.
 */
import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { TodoItem } from "@src/store/ui/todoAtom";

import {
  isExpectedTodoLoadRejection,
  sanitizeTodoDisplayText,
} from "../todoNormalization";
import {
  extractTodosFromManageTodoSequence,
  findLatestManageTodoEvent,
  isManageTodoEvent,
  normalizePersistedTodo,
  normalizePersistedTodoList,
  serializeTodoSnapshot,
} from "../useTodoSync";

describe("normalizePersistedTodo", () => {
  it("uses the provided id when present", () => {
    const todo = normalizePersistedTodo(
      {
        id: "real-id",
        content: "do the thing",
        status: "in_progress",
      },
      0
    );
    expect(todo.id).toBe("real-id");
    expect(todo.content).toBe("do the thing");
    expect(todo.status).toBe("in_progress");
  });

  it("falls back to positional id when id is missing / empty", () => {
    expect(normalizePersistedTodo({}, 0).id).toBe("persisted-0");
    expect(normalizePersistedTodo({ id: "" }, 3).id).toBe("persisted-3");
    expect(normalizePersistedTodo({ id: null }, 7).id).toBe("persisted-7");
  });

  it("defaults content to empty string when absent", () => {
    expect(normalizePersistedTodo({}, 0).content).toBe("");
    expect(normalizePersistedTodo({ content: null }, 0).content).toBe("");
  });

  it("preserves non-empty activeForm; drops empty / non-string", () => {
    expect(
      normalizePersistedTodo({ activeForm: "doing the thing" }, 0).activeForm
    ).toBe("doing the thing");
    expect(
      normalizePersistedTodo({ activeForm: "" }, 0).activeForm
    ).toBeUndefined();
    expect(
      normalizePersistedTodo({ activeForm: null }, 0).activeForm
    ).toBeUndefined();
    expect(normalizePersistedTodo({}, 0).activeForm).toBeUndefined();
  });

  it("defaults status to 'pending'", () => {
    expect(normalizePersistedTodo({}, 0).status).toBe("pending");
    expect(normalizePersistedTodo({ status: null }, 0).status).toBe("pending");
    expect(normalizePersistedTodo({ status: "completed" }, 0).status).toBe(
      "completed"
    );
  });

  it("preserves non-empty blockedBy; drops empty / null", () => {
    const withDeps = normalizePersistedTodo({ blockedBy: [1, 2] }, 0);
    expect(withDeps.blockedBy).toEqual([1, 2]);

    expect(
      normalizePersistedTodo({ blockedBy: [] }, 0).blockedBy
    ).toBeUndefined();
    expect(
      normalizePersistedTodo({ blockedBy: null }, 0).blockedBy
    ).toBeUndefined();
    expect(normalizePersistedTodo({}, 0).blockedBy).toBeUndefined();
  });

  it("never produces a todo with both id collision and missing id", () => {
    // Regression: two rows in a row with missing ids must produce
    // distinct positional ids so the React keyed list doesn't
    // collapse them.
    const list = [
      normalizePersistedTodo({ content: "a" }, 0),
      normalizePersistedTodo({ content: "b" }, 1),
    ];
    expect(list[0].id).toBe("persisted-0");
    expect(list[1].id).toBe("persisted-1");
    expect(list[0].id).not.toBe(list[1].id);
  });
});

describe("sanitizeTodoDisplayText", () => {
  it("replaces standalone internal plan artifacts with an approved plan label", () => {
    expect(sanitizeTodoDisplayText("plan_subagent.plan.md")).toBe(
      "Implement approved plan"
    );
    expect(sanitizeTodoDisplayText(".orgii/plans/plan_sdeagent.plan.md")).toBe(
      "Implement approved plan"
    );
  });

  it("replaces internal plan artifacts inside readable todo titles", () => {
    expect(sanitizeTodoDisplayText("Read plan_subagent.plan.md")).toBe(
      "Read approved plan"
    );
    expect(
      sanitizeTodoDisplayText("Implement tasks from `.orgii/plans/foo.plan.md`")
    ).toBe("Implement tasks from `approved plan`");
  });

  it("preserves normal markdown files that are user task targets", () => {
    expect(sanitizeTodoDisplayText("Create orgii-plan-updated-123.md")).toBe(
      "Create orgii-plan-updated-123.md"
    );
  });
});

describe("normalizePersistedTodoList", () => {
  it("returns [] for null / undefined", () => {
    expect(normalizePersistedTodoList(null)).toEqual([]);
    expect(normalizePersistedTodoList(undefined)).toEqual([]);
  });

  it("returns [] for non-array inputs (Rust serde shape changed)", () => {
    expect(normalizePersistedTodoList({} as unknown as unknown[])).toEqual([]);
    expect(
      normalizePersistedTodoList("not array" as unknown as unknown[])
    ).toEqual([]);
  });

  it("maps each row through normalizePersistedTodo with the correct index", () => {
    const list = normalizePersistedTodoList([
      { content: "first" },
      { content: "second" },
      { content: "third" },
    ]);
    expect(list).toHaveLength(3);
    expect(list.map((t) => t.id)).toEqual([
      "persisted-0",
      "persisted-1",
      "persisted-2",
    ]);
    expect(list.map((t) => t.content)).toEqual(["first", "second", "third"]);
  });

  it("handles a mix of complete and incomplete rows", () => {
    const list = normalizePersistedTodoList([
      { id: "real", content: "ok", status: "completed" },
      {},
      { activeForm: "doing", blockedBy: [0] },
    ]);
    expect(list[0].id).toBe("real");
    expect(list[0].status).toBe("completed");
    expect(list[1].id).toBe("persisted-1");
    expect(list[1].status).toBe("pending");
    expect(list[2].activeForm).toBe("doing");
    expect(list[2].blockedBy).toEqual([0]);
  });

  it("treats null elements gracefully (defensive normalization)", () => {
    const list = normalizePersistedTodoList([
      null as unknown,
      undefined as unknown,
      { content: "real" },
    ]);
    expect(list).toHaveLength(3);
    expect(list[0].content).toBe("");
    expect(list[1].content).toBe("");
    expect(list[2].content).toBe("real");
  });

  it("preserves an empty list (not the same as null)", () => {
    expect(normalizePersistedTodoList([])).toEqual([]);
  });
});

describe("isExpectedTodoLoadRejection", () => {
  it("returns true for the canonical 'not a coding agent' shape", () => {
    expect(
      isExpectedTodoLoadRejection(new Error("session is not a coding agent"))
    ).toBe(true);
  });

  it("returns true for the canonical 'not supported' shape", () => {
    expect(
      isExpectedTodoLoadRejection(new Error("operation not supported"))
    ).toBe(true);
  });

  it("returns false for transport / network errors", () => {
    expect(
      isExpectedTodoLoadRejection(new Error("Tauri IPC unavailable"))
    ).toBe(false);
    expect(isExpectedTodoLoadRejection(new Error("failed to fetch"))).toBe(
      false
    );
  });

  it("returns false for schema / parsing errors", () => {
    expect(
      isExpectedTodoLoadRejection(new Error("invalid type expected string"))
    ).toBe(false);
  });

  it("falls back to String(err) for non-Error rejections", () => {
    expect(isExpectedTodoLoadRejection("not a coding agent — string")).toBe(
      true
    );
    expect(isExpectedTodoLoadRejection({ kind: "not supported" })).toBe(false);
    // ^ stringifies to "[object Object]" → no match.
  });

  it("returns false for empty / null / undefined", () => {
    expect(isExpectedTodoLoadRejection(null)).toBe(false);
    expect(isExpectedTodoLoadRejection(undefined)).toBe(false);
    expect(isExpectedTodoLoadRejection("")).toBe(false);
  });

  it("is case-sensitive (Rust messages are lowercase by convention)", () => {
    // If Rust suddenly returns the message in TitleCase the discriminator
    // should fail-closed (warn) rather than silently swallow. This pins
    // the behaviour so a future Rust capitalisation change is visible
    // in test fallout.
    expect(isExpectedTodoLoadRejection(new Error("Not A Coding Agent"))).toBe(
      false
    );
  });
});

function makeManageTodoEvent(
  overrides: Partial<SessionEvent> & Pick<SessionEvent, "id">
): SessionEvent {
  return {
    chunk_id: overrides.id,
    sessionId: "sdeagent-test",
    createdAt: "2026-01-01T00:00:00.000Z",
    functionName: "manage_todo",
    uiCanonical: "manage_todo",
    actionType: "tool_call",
    args: {},
    result: {},
    source: "assistant",
    displayText: "",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "processed",
    ...overrides,
  };
}

describe("isManageTodoEvent", () => {
  it("matches manage_todo functionName", () => {
    expect(
      isManageTodoEvent(
        makeManageTodoEvent({ id: "todo-1", functionName: "manage_todo" })
      )
    ).toBe(true);
  });

  it("returns false for unrelated events", () => {
    expect(
      isManageTodoEvent(
        makeManageTodoEvent({ id: "read-1", functionName: "read_file" })
      )
    ).toBe(false);
  });
});

describe("findLatestManageTodoEvent", () => {
  it("returns the latest manage_todo for the requested session", () => {
    const events = [
      makeManageTodoEvent({ id: "todo-old" }),
      makeManageTodoEvent({ id: "other-session", sessionId: "other" }),
      makeManageTodoEvent({ id: "todo-new" }),
    ];

    expect(findLatestManageTodoEvent(events, "sdeagent-test")?.id).toBe(
      "todo-new"
    );
  });

  it("respects replay maxIndex", () => {
    const events = [
      makeManageTodoEvent({ id: "todo-old" }),
      makeManageTodoEvent({ id: "todo-new" }),
    ];

    expect(findLatestManageTodoEvent(events, "sdeagent-test", 0)?.id).toBe(
      "todo-old"
    );
  });
});

describe("extractTodosFromManageTodoSequence", () => {
  function nativeTodoContent(
    header: string,
    todos: Array<Record<string, unknown>>
  ): string {
    return [
      header,
      JSON.stringify(todos, null, 2),
      "",
      "Ensure that you continue to use the todo list to track your progress.",
    ].join("\n");
  }

  it("prefers the authoritative Rust snapshot over stale tool args", () => {
    const staleArgs = Array.from({ length: 7 }, (_, index) => ({
      id: `todo-${index}`,
      content: `Task ${index + 1}`,
      status: index < 2 ? "completed" : "pending",
    }));
    const authoritativeTodos = staleArgs.map((todo, index) => ({
      ...todo,
      status: index < 6 ? "completed" : "in_progress",
    }));

    const events = [
      makeManageTodoEvent({
        id: "todo-update",
        args: { action: "update", todos: staleArgs },
        extracted: {
          kind: "todo",
          todos: authoritativeTodos,
          wasMerge: false,
        },
      }),
    ];

    const todos = extractTodosFromManageTodoSequence(events, "sdeagent-test");

    expect(todos).toHaveLength(7);
    expect(todos.filter((todo) => todo.status === "completed")).toHaveLength(6);
    expect(todos[6]?.status).toBe("in_progress");
  });

  it("treats a completed authoritative empty snapshot as a clear", () => {
    const events = [
      makeManageTodoEvent({
        id: "todo-write",
        extracted: {
          kind: "todo",
          todos: [{ id: "todo-1", content: "Task", status: "pending" }],
          wasMerge: false,
        },
      }),
      makeManageTodoEvent({
        id: "todo-clear",
        extracted: { kind: "todo", todos: [], wasMerge: false },
      }),
    ];

    expect(extractTodosFromManageTodoSequence(events, "sdeagent-test")).toEqual(
      []
    );
  });

  it("does not clear from an incomplete pre-result event", () => {
    const events = [
      makeManageTodoEvent({
        id: "todo-write",
        extracted: {
          kind: "todo",
          todos: [{ id: "todo-1", content: "Task", status: "pending" }],
          wasMerge: false,
        },
      }),
      makeManageTodoEvent({
        id: "todo-running",
        displayStatus: "running",
        extracted: { kind: "todo", todos: [], wasMerge: false },
      }),
    ];

    expect(extractTodosFromManageTodoSequence(events, "sdeagent-test")).toEqual(
      [{ id: "todo-1", content: "Task", status: "pending" }]
    );
  });

  it("backfills empty titles in later update snapshots from earlier todo events", () => {
    const events = [
      makeManageTodoEvent({
        id: "todo-write",
        result: {
          content: nativeTodoContent("3 todos (3 remaining)", [
            {
              index: 0,
              content: "Review remaining version metadata changes",
              status: "pending",
            },
            {
              index: 1,
              content: "Verify synchronized release version",
              status: "pending",
            },
            {
              index: 2,
              content: "Commit synchronized release metadata",
              status: "pending",
            },
          ]),
        },
      }),
      makeManageTodoEvent({
        id: "todo-update",
        result: {
          content: nativeTodoContent(
            "Updated todo #2 — 3 todos (1 remaining)",
            [
              { index: 0, content: "", status: "completed" },
              { index: 1, content: "   ", status: "completed" },
              {
                index: 2,
                content: "Verify commits and clean working tree",
                status: "in_progress",
              },
            ]
          ),
        },
      }),
    ];

    const todos = extractTodosFromManageTodoSequence(events, "sdeagent-test");

    expect(todos.map((todo) => todo.content)).toEqual([
      "Review remaining version metadata changes",
      "Verify synchronized release version",
      "Verify commits and clean working tree",
    ]);
    expect(todos.map((todo) => todo.status)).toEqual([
      "completed",
      "completed",
      "in_progress",
    ]);
  });
});

describe("serializeTodoSnapshot dedup", () => {
  /**
   * Mirrors the useTodoSync effect guard chain:
   *   1. skip when extracted todos are empty (pre-merge tool_call)
   *   2. skip when snapshot matches lastProcessedTodoSnapshotRef
   *
   * Regression for #247: event-id dedup blocked refresh when the same
   * manage_todo tool_call id was merged with populated todos.
   */
  function simulateTodoSyncDedup(
    lastSnapshot: string | null,
    todos: TodoItem[]
  ): { lastSnapshot: string | null; applied: boolean } {
    if (todos.length === 0) {
      return { lastSnapshot, applied: false };
    }
    const snapshot = serializeTodoSnapshot(todos);
    if (snapshot === lastSnapshot) {
      return { lastSnapshot, applied: false };
    }
    return { lastSnapshot: snapshot, applied: true };
  }

  it("allows update when same event id transitions from empty to populated todos", () => {
    let lastSnapshot: string | null = null;

    // Phase 1: tool_call arrives before tool_result merge — no todos yet.
    const preMerge = simulateTodoSyncDedup(lastSnapshot, []);
    expect(preMerge.applied).toBe(false);
    expect(preMerge.lastSnapshot).toBeNull();
    lastSnapshot = preMerge.lastSnapshot;

    // Phase 2: same event id, now merged with populated todos.
    const populatedTodos: TodoItem[] = [
      { id: "t1", content: "Implement feature", status: "pending" },
      { id: "t2", content: "Write tests", status: "in_progress" },
    ];
    const postMerge = simulateTodoSyncDedup(lastSnapshot, populatedTodos);
    expect(postMerge.applied).toBe(true);
    expect(postMerge.lastSnapshot).not.toBeNull();
    expect(postMerge.lastSnapshot).not.toBe(lastSnapshot);
    lastSnapshot = postMerge.lastSnapshot;

    // Phase 3: identical re-process of merged event dedups on snapshot.
    const replay = simulateTodoSyncDedup(lastSnapshot, populatedTodos);
    expect(replay.applied).toBe(false);
    expect(replay.lastSnapshot).toBe(lastSnapshot);
  });

  it("detects snapshot changes when todo status updates on same event", () => {
    const base: TodoItem[] = [{ id: "t1", content: "Task", status: "pending" }];
    const updated: TodoItem[] = [
      { id: "t1", content: "Task", status: "completed" },
    ];

    const before = serializeTodoSnapshot(base);
    const after = serializeTodoSnapshot(updated);
    expect(before).not.toBe(after);
  });
});
