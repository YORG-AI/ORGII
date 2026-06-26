import { describe, expect, it } from "vitest";

import { getFileTypeFromName } from "./utils";

describe("getFileTypeFromName", () => {
  it("detects dotfiles and rc files before extension fallback", () => {
    expect(getFileTypeFromName(".gitattributes")).toBe("git");
    expect(getFileTypeFromName(".gitignore")).toBe("git");
    expect(getFileTypeFromName(".npmrc")).toBe("npm");
    expect(getFileTypeFromName(".svgrrc")).toBe("svgr");
    expect(getFileTypeFromName(".madgerc")).toBe("rc");
    expect(getFileTypeFromName(".unimportedrc.json")).toBe("rc");
  });
});
