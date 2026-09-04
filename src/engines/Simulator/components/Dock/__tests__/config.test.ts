import { describe, expect, it } from "vitest";

import { FileDiffIcon } from "@src/icons";

import { getAppById } from "../config";

describe("simulator dock app icons", () => {
  it("uses the file-diff glyph for Diff", () => {
    expect(getAppById("DIFF")?.icon).toBe(FileDiffIcon);
  });
});
