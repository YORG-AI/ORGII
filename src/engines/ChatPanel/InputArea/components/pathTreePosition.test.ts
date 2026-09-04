import { describe, expect, it } from "vitest";

import { resolvePathTreePosition } from "./pathTreePosition";

describe("resolvePathTreePosition", () => {
  it("opens left with the sidebar visible and right when hidden", () => {
    expect(resolvePathTreePosition(false)).toBe("left");
    expect(resolvePathTreePosition(true)).toBe("right");
  });
});
