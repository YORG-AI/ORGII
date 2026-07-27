import { describe, expect, it } from "vitest";

import { createThreadTodo, normalizeThreadTodos } from "../threadTodos";

describe("thread todo presentation", () => {
  it("drops blank persisted rows and trims visible content", () => {
    expect(
      normalizeThreadTodos([
        { id: "blank", content: "   ", status: "pending" },
        { id: "kept", content: "  Verify inbox  ", status: "completed" },
      ])
    ).toEqual([{ id: "kept", content: "Verify inbox", status: "completed" }]);
  });

  it("creates a pending todo only after non-empty input is committed", () => {
    expect(createThreadTodo("  Add compact composer  ", 42)).toEqual({
      id: "todo-42",
      content: "Add compact composer",
      status: "pending",
    });
    expect(createThreadTodo("   ", 42)).toBeNull();
  });

  it("enforces the 120 character domain boundary", () => {
    expect(createThreadTodo("x".repeat(140), 42)?.content).toHaveLength(120);
  });
});
