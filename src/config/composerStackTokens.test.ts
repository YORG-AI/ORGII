import { describe, expect, it } from "vitest";

import { COMPOSER_BOTTOM_DOCK_PADDING_CLASS } from "./composerStackTokens";

describe("composer stack tokens", () => {
  it("keeps every bottom-docked composer 12px from its surface edge", () => {
    expect(COMPOSER_BOTTOM_DOCK_PADDING_CLASS).toBe("pb-3");
  });
});
