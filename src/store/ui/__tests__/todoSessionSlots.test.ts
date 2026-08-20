import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import { workstationActiveSessionIdAtom } from "@src/store/session";
import {
  MAX_TODO_SESSION_SLOTS,
  sessionTodoMapAtom,
  updateTodosForSessionAtom,
} from "@src/store/ui/todoAtom";

describe("sessionTodoMapAtom slot cap", () => {
  it("evicts the least-recently-updated inactive sessions past the cap", () => {
    const store = createStore();
    store.set(workstationActiveSessionIdAtom, "active");

    // The active session writes first, so it would be the LRU victim if
    // the cap didn't protect it.
    store.set(updateTodosForSessionAtom, {
      sessionId: "active",
      todos: [{ id: "1", content: "keep me", status: "pending" }],
    });
    for (let i = 0; i < MAX_TODO_SESSION_SLOTS + 4; i++) {
      store.set(updateTodosForSessionAtom, {
        sessionId: `s${i}`,
        todos: [{ id: "1", content: `todo ${i}`, status: "pending" }],
      });
    }

    const map = store.get(sessionTodoMapAtom);
    expect(map.size).toBe(MAX_TODO_SESSION_SLOTS);
    expect(map.has("active")).toBe(true);
    // Oldest inactive slots are gone, newest survive.
    expect(map.has("s0")).toBe(false);
    expect(map.has(`s${MAX_TODO_SESSION_SLOTS + 3}`)).toBe(true);
  });

  it("re-updating a session refreshes its LRU position", () => {
    const store = createStore();
    store.set(workstationActiveSessionIdAtom, null);
    for (let i = 0; i < MAX_TODO_SESSION_SLOTS; i++) {
      store.set(updateTodosForSessionAtom, {
        sessionId: `s${i}`,
        todos: [{ id: "1", content: `todo ${i}`, status: "pending" }],
      });
    }
    // Touch s0 so it becomes most-recent, then overflow by one.
    store.set(updateTodosForSessionAtom, {
      sessionId: "s0",
      todos: [{ id: "2", content: "touched", status: "pending" }],
    });
    store.set(updateTodosForSessionAtom, {
      sessionId: "overflow",
      todos: [{ id: "1", content: "new", status: "pending" }],
    });
    const map = store.get(sessionTodoMapAtom);
    expect(map.size).toBe(MAX_TODO_SESSION_SLOTS);
    expect(map.has("s0")).toBe(true);
    expect(map.has("s1")).toBe(false);
  });
});
