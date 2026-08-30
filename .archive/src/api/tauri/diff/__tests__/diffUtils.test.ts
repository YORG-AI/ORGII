import { vi } from "vitest";

import { extractDiffFilePath, isUnifiedDiff } from "..";

vi.mock("@src/api/tauri/rpc", () => ({ rpc: {} }));

describe("isUnifiedDiff", () => {
  it("detects unified diff markers in the first lines", () => {
    expect(isUnifiedDiff("@@ -1,3 +1,4 @@\ncontext")).toBe(true);
    expect(isUnifiedDiff("diff --git a/file b/file")).toBe(true);
    expect(isUnifiedDiff("--- a/foo.ts")).toBe(true);
    expect(isUnifiedDiff("+++ b/foo.ts")).toBe(true);
    expect(isUnifiedDiff("just text")).toBe(false);
    expect(isUnifiedDiff("")).toBe(false);
  });
});

describe("extractDiffFilePath", () => {
  it("reads path from --- a/ header or returns null", () => {
    expect(extractDiffFilePath("--- a/src/foo.ts\n+++ b/src/foo.ts")).toBe(
      "src/foo.ts"
    );
    expect(extractDiffFilePath("no diff header")).toBeNull();
  });
});
