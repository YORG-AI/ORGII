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

describe("dropdown section labels", () => {
  it("pins the current section over scrolling menu rows", () => {
    expect(DROPDOWN_CLASSES.sectionLabel).toContain("sticky");
    expect(DROPDOWN_CLASSES.sectionLabel).toContain("-top-1");
    expect(DROPDOWN_CLASSES.sectionLabel).not.toContain("top-0");
    expect(DROPDOWN_CLASSES.sectionLabel).toContain("z-10");
    expect(DROPDOWN_CLASSES.sectionLabel).toContain("bg-bg-2");
  });
});

describe("dropdown control rows", () => {
  it("leaves row hover styling to the embedded option control", () => {
    expect(DROPDOWN_CLASSES.menuControlItem).not.toContain("hover:bg-");
    expect(DROPDOWN_CLASSES.menuActionItem).toContain("hover:bg-");
  });
});
