import { describe, expect, it } from "vitest";

import { computeLspDropdownPosition } from "./useLspDropdown";

const viewport = { width: 1440, height: 900 };

describe("computeLspDropdownPosition", () => {
  it("anchors the panel just above the trigger", () => {
    expect(
      computeLspDropdownPosition({ top: 880, right: 1400 }, viewport)
    ).toEqual({ bottom: 24, right: 40 });
  });

  it("right-aligns the panel with the trigger's right edge", () => {
    expect(
      computeLspDropdownPosition({ top: 880, right: 1440 }, viewport)
    ).toEqual({ bottom: 24, right: 0 });
  });

  it("scales with the viewport rather than the document", () => {
    expect(
      computeLspDropdownPosition(
        { top: 300, right: 500 },
        { width: 800, height: 600 }
      )
    ).toEqual({ bottom: 304, right: 300 });
  });
});
