import { describe, expect, it } from "vitest";

import type { SpotlightItem } from "../../../types";
import { findCurrentSelectionIndex } from "../modelSection";

function item(id: string, isCurrentSelection?: boolean): SpotlightItem {
  return {
    id,
    label: id,
    icon: "",
    type: "action",
    data: isCurrentSelection ? { isCurrentSelection: true } : undefined,
    action: () => undefined,
  };
}

describe("findCurrentSelectionIndex", () => {
  it("returns the persisted selection instead of the first selectable row", () => {
    const items = [
      item("recent-gpt-5.6"),
      item("recent-gpt-5.5-high-fast", true),
      item("all-gpt-5.5"),
    ];

    expect(findCurrentSelectionIndex(items)).toBe(1);
  });

  it("returns -1 when no current selection is available", () => {
    expect(findCurrentSelectionIndex([item("gpt-5.6"), item("gpt-5.5")])).toBe(
      -1
    );
  });
});
