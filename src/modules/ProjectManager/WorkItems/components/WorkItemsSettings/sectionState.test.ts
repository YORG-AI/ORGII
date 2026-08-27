import { describe, expect, it } from "vitest";

import { advanceSettingsSectionState } from ".";

describe("advanceSettingsSectionState", () => {
  it("applies each stamped deep-link request exactly once", () => {
    const initial = {
      activeSection: "general" as const,
      appliedRequestStamp: null,
    };
    const first = advanceSettingsSectionState(initial, {
      section: "sync",
      stamp: 1,
    });
    expect(first).toEqual({
      activeSection: "sync",
      appliedRequestStamp: 1,
    });
    expect(
      advanceSettingsSectionState(
        { ...first, activeSection: "labels" },
        { section: "sync", stamp: 1 }
      )
    ).toEqual({ activeSection: "labels", appliedRequestStamp: 1 });
  });

  it("reapplies the same section for a newer request stamp", () => {
    expect(
      advanceSettingsSectionState(
        { activeSection: "labels", appliedRequestStamp: 1 },
        { section: "sync", stamp: 2 }
      )
    ).toEqual({ activeSection: "sync", appliedRequestStamp: 2 });
  });
});
