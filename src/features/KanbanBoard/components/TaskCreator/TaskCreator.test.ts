import { describe, expect, it } from "vitest";

import { getTaskCreatorInitials, truncateTaskCreatorName } from ".";

describe("getTaskCreatorInitials", () => {
  it("uses the first two name initials for the default avatar", () => {
    expect(getTaskCreatorInitials("Ada Lovelace")).toBe("AL");
    expect(getTaskCreatorInitials("grace")).toBe("G");
  });

  it("keeps an empty display name visible as an unknown letter", () => {
    expect(getTaskCreatorInitials("   ")).toBe("?");
  });
});

describe("truncateTaskCreatorName", () => {
  it("keeps at most the first 12 Unicode characters plus an ellipsis", () => {
    expect(truncateTaskCreatorName("abcdefghijklmnop", 12)).toBe(
      "abcdefghijkl…"
    );
    expect(truncateTaskCreatorName("你好世界", 12)).toBe("你好世界");
  });
});
