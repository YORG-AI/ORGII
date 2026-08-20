import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import {
  SEARCH_MAX_RETAINED_MATCHES,
  searchAppendResultsAtom,
  searchHasMoreAtom,
  searchResultsAtom,
} from "@src/store/workstation/codeEditor/search";
import type { SearchResultFile } from "@src/store/workstation/codeEditor/search/types";

function file(path: string, matchCount: number): SearchResultFile {
  return {
    file_path: path,
    matches: Array.from({ length: matchCount }, (_, idx) => ({
      line: idx + 1,
      column: 0,
      end_line: idx + 1,
      end_column: 5,
      text: `match ${idx}`,
      context_before: "",
      context_after: "",
    })),
  };
}

describe("searchAppendResultsAtom", () => {
  it("appends results while under the retained-match ceiling", () => {
    const store = createStore();
    store.set(searchHasMoreAtom, true);
    store.set(searchAppendResultsAtom, [file("/a.ts", 10), file("/b.ts", 5)]);
    expect(store.get(searchResultsAtom).map((f) => f.file_path)).toEqual([
      "/a.ts",
      "/b.ts",
    ]);
    expect(store.get(searchHasMoreAtom)).toBe(true);
  });

  it("stops accumulating at SEARCH_MAX_RETAINED_MATCHES and clears hasMore", () => {
    const store = createStore();
    store.set(searchHasMoreAtom, true);
    const perFile = 1_000;
    const filesToCap = SEARCH_MAX_RETAINED_MATCHES / perFile;
    const batch: SearchResultFile[] = [];
    for (let i = 0; i < filesToCap + 3; i++) {
      batch.push(file(`/f${i}.ts`, perFile));
    }
    store.set(searchAppendResultsAtom, batch);

    const retained = store.get(searchResultsAtom);
    expect(retained).toHaveLength(filesToCap);
    expect(
      retained.reduce((sum, f) => sum + f.matches.length, 0)
    ).toBeLessThanOrEqual(SEARCH_MAX_RETAINED_MATCHES);
    expect(store.get(searchHasMoreAtom)).toBe(false);

    // Further appends are no-ops once the ceiling is reached.
    store.set(searchAppendResultsAtom, [file("/late.ts", 1)]);
    expect(store.get(searchResultsAtom)).toHaveLength(filesToCap);
  });
});
