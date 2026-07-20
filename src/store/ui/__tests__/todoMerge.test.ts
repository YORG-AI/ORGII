import { describe, expect, it } from "vitest";

import { preserveTodoContent, reconcileTodoSnapshot } from "../todoMerge";

describe("preserveTodoContent", () => {
  it("keeps incoming non-empty content unchanged", () => {
    const result = preserveTodoContent(
      [{ id: "0", content: "Old title" }],
      [{ id: "0", content: "New title", status: "completed" }]
    );

    expect(result[0]).toEqual({
      id: "0",
      content: "New title",
      status: "completed",
    });
  });

  it("fills an empty incoming title from the previous todo with the same id", () => {
    const result = preserveTodoContent(
      [{ id: "0", content: "Review remaining metadata" }],
      [{ id: "0", content: "", status: "completed" }]
    );

    expect(result[0]).toEqual({
      id: "0",
      content: "Review remaining metadata",
      status: "completed",
    });
  });

  it("falls back to position when ids changed but order stayed stable", () => {
    const result = preserveTodoContent(
      [{ id: "persisted-0", content: "Verify synchronized release version" }],
      [{ id: "0", content: "   ", status: "completed" }]
    );

    expect(result[0].content).toBe("Verify synchronized release version");
  });

  it("leaves empty content alone when there is no previous title", () => {
    const result = preserveTodoContent(
      [],
      [{ id: "0", content: "", status: "completed" }]
    );

    expect(result[0].content).toBe("");
  });
});

describe("reconcileTodoSnapshot", () => {
  it("takes statuses from the current snapshot for the same todo batch", () => {
    const result = reconcileTodoSnapshot(
      [
        { id: "0", content: "Inspect state", status: "in_progress" },
        { id: "1", content: "Fix routing", status: "pending" },
      ],
      [
        { id: "0", content: "Inspect state", status: "completed" },
        { id: "1", content: "Fix routing", status: "cancelled" },
      ]
    );

    expect(result.map((todo) => todo.status)).toEqual([
      "completed",
      "cancelled",
    ]);
  });

  it("keeps the event snapshot for a different historical batch", () => {
    const result = reconcileTodoSnapshot(
      [{ id: "0", content: "Old task", status: "pending" }],
      [{ id: "0", content: "New task", status: "completed" }]
    );

    expect(result).toEqual([
      { id: "0", content: "Old task", status: "pending" },
    ]);
  });
});
