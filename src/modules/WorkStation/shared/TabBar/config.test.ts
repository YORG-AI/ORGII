import { describe, expect, it } from "vitest";

import { TAB_PAIR_SEPARATOR_SLOT_CLASS } from "./config";

describe("tab bar spacing", () => {
  it("keeps a one-pixel separator with four pixels of space between pills", () => {
    expect(TAB_PAIR_SEPARATOR_SLOT_CLASS).toContain("mx-0.5");
    expect(TAB_PAIR_SEPARATOR_SLOT_CLASS).toContain("w-px");
  });
});
