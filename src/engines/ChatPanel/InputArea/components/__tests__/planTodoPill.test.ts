import { describe, expect, it } from "vitest";

import type { TodoItem } from "@src/store/ui/todoAtom";

import { countCompletedTodos } from "../PlanTodoPill";

function todo(status: TodoItem["status"]): TodoItem {
  return {
    id: status,
    content: status,
    status,
  };
}

describe("countCompletedTodos", () => {
  it("reports completed todos for the pill numerator", () => {
    expect(
      countCompletedTodos([
        todo("completed"),
        todo("in_progress"),
        todo("pending"),
      ])
    ).toBe(1);
  });

  it("does not present cancelled todos as completed", () => {
    expect(countCompletedTodos([todo("cancelled"), todo("completed")])).toBe(1);
  });
});
