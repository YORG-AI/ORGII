import { describe, expect, it } from "vitest";

import { resolvePath } from "./utils";

describe("resolvePath", () => {
  const windowsRepo = "C:\\Repos\\ORGII";

  it("keeps POSIX absolute paths unchanged", () => {
    expect(resolvePath("/tmp/project/package.json", windowsRepo)).toBe(
      "/tmp/project/package.json"
    );
  });

  it("keeps Windows drive-letter paths unchanged", () => {
    expect(resolvePath("C:\\Repos\\ORGII\\package.json", windowsRepo)).toBe(
      "C:\\Repos\\ORGII\\package.json"
    );
    expect(resolvePath("C:/Projects/ORGII/package.json", windowsRepo)).toBe(
      "C:/Projects/ORGII/package.json"
    );
  });

  it("keeps Windows UNC and verbatim paths unchanged", () => {
    expect(resolvePath("\\\\server\\share\\package.json", windowsRepo)).toBe(
      "\\\\server\\share\\package.json"
    );
    expect(
      resolvePath("\\\\?\\C:\\Repos\\ORGII\\package.json", windowsRepo)
    ).toBe("\\\\?\\C:\\Repos\\ORGII\\package.json");
  });

  it("resolves relative paths against the repository", () => {
    expect(resolvePath("src/index.ts", windowsRepo)).toBe(
      "C:\\Repos\\ORGII/src/index.ts"
    );
  });
});
