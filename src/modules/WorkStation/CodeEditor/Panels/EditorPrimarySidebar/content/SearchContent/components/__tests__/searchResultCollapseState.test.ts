import { describe, expect, it } from "vitest";

import {
  advanceSearchResultCollapseState,
  createSearchResultCollapseState,
} from "../searchResultCollapseState";
import type { SearchResultFile } from "../types";

const result = (filePath: string, matchCount: number): SearchResultFile => ({
  file_path: filePath,
  matches: Array.from({ length: matchCount }, () => ({
    line: 1,
    column: 1,
    text: "match",
    context_before: "",
    context_after: "",
  })),
});

describe("search result collapse state", () => {
  it("auto-collapses an oversized initial result without a post-commit reset", () => {
    const state = createSearchResultCollapseState(
      [result("a.ts", 20), result("b.ts", 20)],
      40,
      25
    );
    expect([...state.collapsedFiles]).toEqual(["a.ts", "b.ts"]);
  });

  it("resets user collapse state for a new small search", () => {
    const previous = {
      firstFile: "a.ts",
      resultCount: 2,
      collapsedFiles: new Set(["a.ts", "b.ts"]),
    };
    const next = advanceSearchResultCollapseState(
      previous,
      [result("new.ts", 1)],
      1,
      25,
      true
    );
    expect(next.collapsedFiles.size).toBe(0);
  });

  it("collapses newly loaded files only on the load-more surface", () => {
    const previous = {
      firstFile: "a.ts",
      resultCount: 1,
      collapsedFiles: new Set<string>(),
    };
    const results = [result("a.ts", 20), result("b.ts", 20)];
    expect(
      advanceSearchResultCollapseState(previous, results, 40, 25, true)
        .collapsedFiles
    ).toEqual(new Set(["a.ts", "b.ts"]));
    expect(
      advanceSearchResultCollapseState(previous, results, 40, 25, false)
        .collapsedFiles
    ).toEqual(new Set());
  });
});
