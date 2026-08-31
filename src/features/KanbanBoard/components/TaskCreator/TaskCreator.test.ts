import { describe, expect, it } from "vitest";

import { truncateTaskCreatorName } from ".";

describe("truncateTaskCreatorName", () => {
  it("keeps at most the first 12 Unicode characters plus an ellipsis", () => {
    expect(truncateTaskCreatorName("abcdefghijklmnop", 12)).toBe(
      "abcdefghijkl…"
    );
    expect(truncateTaskCreatorName("你好世界", 12)).toBe("你好世界");
  });
});
