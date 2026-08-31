import { describe, expect, it } from "vitest";

import { parseMarkdownFileRef } from "./markdownFileRef";

describe("parseMarkdownFileRef", () => {
  it("separates a trailing line from a POSIX path", () => {
    expect(parseMarkdownFileRef("/repo/src/View.tsx:220")).toEqual({
      path: "/repo/src/View.tsx",
      line: 220,
    });
  });

  it("uses the line and discards an optional column", () => {
    expect(parseMarkdownFileRef("C:\\repo\\src\\View.tsx:220:14")).toEqual({
      path: "C:\\repo\\src\\View.tsx",
      line: 220,
    });
  });

  it("leaves ordinary paths and invalid 1-based lines unchanged", () => {
    expect(parseMarkdownFileRef("C:\\repo\\src\\View.tsx")).toEqual({
      path: "C:\\repo\\src\\View.tsx",
    });
    expect(parseMarkdownFileRef("/repo/src/View.tsx:0")).toEqual({
      path: "/repo/src/View.tsx:0",
    });
  });
});
