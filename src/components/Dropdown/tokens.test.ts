import { describe, expect, it } from "vitest";

import { DROPDOWN_CLASSES } from "./tokens";

describe("dropdown menu group spacing", () => {
  it("renders a visible separator with a compact local offset", () => {
    expect(DROPDOWN_CLASSES.menuGroupSeparator).toContain("my-0.5");
    expect(DROPDOWN_CLASSES.menuGroupSeparator).toContain("border-t");
    expect(DROPDOWN_CLASSES.menuGroupSeparator).toContain("border-border-2");
    expect(DROPDOWN_CLASSES.menuGroupSeparator).not.toContain("my-1");
  });
});
