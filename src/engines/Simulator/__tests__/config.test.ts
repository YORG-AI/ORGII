import { vi } from "vitest";

import { calculateAutoLayout, getLayoutCells } from "../config";

vi.mock("@src/store/ui/simulatorAtom", () => ({ SimulatorGridLayout: {} }));

describe("calculateAutoLayout", () => {
  it("maps task counts to grid layouts", () => {
    expect(calculateAutoLayout(0)).toBe("1x1");
    expect(calculateAutoLayout(1)).toBe("1x1");
    expect(calculateAutoLayout(2)).toBe("1x2");
    expect(calculateAutoLayout(3)).toBe("2x2");
    expect(calculateAutoLayout(4)).toBe("2x2");
    expect(calculateAutoLayout(5)).toBe("2x3");
    expect(calculateAutoLayout(6)).toBe("2x3");
    expect(calculateAutoLayout(7)).toBe("4x2");
    expect(calculateAutoLayout(8)).toBe("4x2");
    expect(calculateAutoLayout(9)).toBe("3x3");
    expect(calculateAutoLayout(10)).toBe("3x4");
    expect(calculateAutoLayout(12)).toBe("3x4");
  });
});

describe("getLayoutCells", () => {
  it("returns row × col for each layout key", () => {
    expect(getLayoutCells("1x1")).toBe(1);
    expect(getLayoutCells("1x2")).toBe(2);
    expect(getLayoutCells("2x2")).toBe(4);
    expect(getLayoutCells("2x3")).toBe(6);
    expect(getLayoutCells("3x3")).toBe(9);
    expect(getLayoutCells("4x2")).toBe(8);
    expect(getLayoutCells("3x4")).toBe(12);
  });
});
