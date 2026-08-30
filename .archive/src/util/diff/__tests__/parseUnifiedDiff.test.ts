import { vi } from "vitest";

import { parseUnifiedDiff } from "../index";

vi.mock("@src/api/tauri/diff", () => ({}));

describe("parseUnifiedDiff", () => {
  it("parses simple addition lines", () => {
    const result = parseUnifiedDiff("+only new");
    expect(result.oldValue).toBe("");
    expect(result.newValue).toBe("only new");
  });

  it("parses simple deletion lines", () => {
    const result = parseUnifiedDiff("-only old");
    expect(result.oldValue).toBe("only old");
    expect(result.newValue).toBe("");
  });

  it("parses mixed additions and deletions with shared context", () => {
    const diffText = [" unchanged", "-removed", "+added", " tail"].join("\n");
    const result = parseUnifiedDiff(diffText);
    expect(result.oldValue).toBe("unchanged\nremoved\ntail");
    expect(result.newValue).toBe("unchanged\nadded\ntail");
  });

  it("duplicates context lines into old and new", () => {
    const result = parseUnifiedDiff(" same");
    expect(result.oldValue).toBe("same");
    expect(result.newValue).toBe("same");
  });

  it("skips diff headers and hunk markers", () => {
    const diffText = [
      "diff --git a/f b/f",
      "index 111..222 100644",
      "--- a/f",
      "+++ b/f",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ].join("\n");
    const result = parseUnifiedDiff(diffText);
    expect(result.oldValue).toBe("old");
    expect(result.newValue).toBe("new");
  });

  it("returns empty strings for empty input", () => {
    const result = parseUnifiedDiff("");
    expect(result.oldValue).toBe("");
    expect(result.newValue).toBe("");
  });

  it("treats lines without prefix as unrecognized (not added to either side)", () => {
    const result = parseUnifiedDiff(" a\n\n b");
    expect(result.oldValue).toBe("a\n\nb");
    expect(result.newValue).toBe("a\n\nb");
  });
});
