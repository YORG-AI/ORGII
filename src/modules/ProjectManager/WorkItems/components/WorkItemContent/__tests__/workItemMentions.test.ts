import { describe, expect, it } from "vitest";

import { normalizeWorkItemMentionIds } from "../workItemMentions";

describe("normalizeWorkItemMentionIds", () => {
  const members = [
    { id: "alice", name: "Alice" },
    { id: "bob", name: "Bob" },
    { id: "carol", name: "Carol" },
  ];

  it("keeps stable eligible member ids in first-selected order", () => {
    expect(
      normalizeWorkItemMentionIds(
        [" bob ", "missing", "bob", "carol", "alice"],
        members,
        "alice"
      )
    ).toEqual(["bob", "carol"]);
  });
});
