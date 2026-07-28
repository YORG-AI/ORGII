import { describe, expect, it } from "vitest";

import { calculateFileDropdownPosition } from "./fileDropdownPosition";

const BASE_OPTIONS = {
  viewportWidth: 1200,
  viewportHeight: 800,
  dropdownWidth: 280,
  dropdownMaxHeight: 392,
  viewportMargin: 8,
  triggerGap: 4,
};

describe("calculateFileDropdownPosition", () => {
  it("opens below and left-aligned with the breadcrumb segment", () => {
    expect(
      calculateFileDropdownPosition({
        ...BASE_OPTIONS,
        triggerRect: { bottom: 140, left: 360 },
      })
    ).toEqual({ top: 144, left: 360 });
  });

  it("keeps the dropdown inside the right viewport edge", () => {
    expect(
      calculateFileDropdownPosition({
        ...BASE_OPTIONS,
        viewportWidth: 600,
        triggerRect: { bottom: 140, left: 560 },
      })
    ).toEqual({ top: 144, left: 312 });
  });
});
