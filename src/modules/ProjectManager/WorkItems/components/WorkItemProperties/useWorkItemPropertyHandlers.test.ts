import { describe, expect, it } from "vitest";

import { buildHumanAssigneeUpdate } from "./useWorkItemPropertyHandlers";

describe("buildHumanAssigneeUpdate", () => {
  it("writes a human assignee without coupling it to an execution target", () => {
    const update = buildHumanAssigneeUpdate({
      id: "member-1",
      name: "Ada Lovelace",
    });

    expect(update).toEqual({
      assignee: { id: "member-1", name: "Ada Lovelace" },
      assigneeType: "human",
    });
  });

  it("clears both the human assignment and its type together", () => {
    expect(buildHumanAssigneeUpdate(null)).toEqual({
      assignee: undefined,
      assigneeType: undefined,
    });
  });
});
