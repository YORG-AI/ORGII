import { getLanguageFromFilePath } from "./extension";

describe("getLanguageFromFilePath", () => {
  it.each([
    ["src/App.tsx", "tsx"],
    ["src/Program.cs", "csharp"],
    ["scripts/release.sh", "bash"],
  ])("uses canonical syntax metadata for %s", (filePath, expected) => {
    expect(getLanguageFromFilePath(filePath)).toBe(expected);
  });

  it("retains the syntax-only adapter for uncommon Prism languages", () => {
    expect(getLanguageFromFilePath("grammar.agda")).toBe("agda");
  });
});
