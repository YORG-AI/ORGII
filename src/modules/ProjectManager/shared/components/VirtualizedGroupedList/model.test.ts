import { describe, expect, it } from "vitest";

import { type VirtualizedGroup, buildVirtualizedGroupModel } from "./model";

describe("buildVirtualizedGroupModel", () => {
  const groups: readonly VirtualizedGroup<{ label: string }, string>[] = [
    { key: "open", group: { label: "Open" }, items: ["a", "b"] },
    { key: "closed", group: { label: "Closed" }, items: ["c"] },
  ];

  it("keeps headers but omits collapsed row references", () => {
    const model = buildVirtualizedGroupModel(
      groups,
      (group) => group.key === "open"
    );

    expect(model.groupCounts).toEqual([2, 0]);
    expect(model.rows.map((row) => row.item)).toEqual(["a", "b"]);
    expect(model.rows.map((row) => row.isLastInGroup)).toEqual([false, true]);
  });

  it("does not mutate parent-owned group arrays", () => {
    const originalGroups = groups.map((group) => group);
    const originalItems = groups.map((group) => group.items);

    buildVirtualizedGroupModel(groups, () => true);

    expect(groups).toEqual(originalGroups);
    expect(groups.map((group) => group.items)).toEqual(originalItems);
  });
});
