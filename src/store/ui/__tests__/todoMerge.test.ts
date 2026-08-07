import { describe, expect, it } from "vitest";

import { preserveTodoContent } from "../todoMerge";

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
