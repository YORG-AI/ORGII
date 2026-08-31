import { describe, expect, it } from "vitest";

import { DIFF_APP_CONFIG } from "../config";

describe("DIFF_APP_CONFIG", () => {
  it("uses the file-diff icon name", () => {
    expect(DIFF_APP_CONFIG.icon).toBe("file-diff");
  });
});
