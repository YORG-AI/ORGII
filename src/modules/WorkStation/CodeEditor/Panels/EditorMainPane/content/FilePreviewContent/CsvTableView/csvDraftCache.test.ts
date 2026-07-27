import { afterEach, describe, expect, it } from "vitest";

import {
  type CsvDraftState,
  clearCsvDraft,
  csvDraftCacheTestApi,
  getCsvDraft,
  setCsvDraft,
} from "./csvDraftCache";

function draft(value: string): CsvDraftState {
  return {
    rows: [[value]],
    originalRows: [["original"]],
    patches: [{ rowIndex: 0, columnIndex: 0, value }],
    nextRow: 1,
    hasMoreRows: false,
  };
}

describe("CSV draft cache", () => {
  afterEach(() => csvDraftCacheTestApi.clear());

  it("isolates retained data and refreshes LRU recency", () => {
    const input = draft("saved");
    expect(setCsvDraft("a.csv", input)).toBe(true);
    input.rows[0][0] = "mutated";

    const first = getCsvDraft("a.csv");
    expect(first?.rows[0][0]).toBe("saved");
    first!.rows[0][0] = "returned mutation";
    expect(getCsvDraft("a.csv")?.rows[0][0]).toBe("saved");
  });

  it("enforces the entry-count limit", () => {
    for (let index = 0; index < csvDraftCacheTestApi.limits.entries; index++) {
      setCsvDraft(`${index}.csv`, draft(String(index)));
    }
    getCsvDraft("0.csv");
    setCsvDraft("new.csv", draft("new"));

    expect(getCsvDraft("0.csv")).not.toBeNull();
    expect(getCsvDraft("1.csv")).toBeNull();
    expect(csvDraftCacheTestApi.stats().entries).toBe(
      csvDraftCacheTestApi.limits.entries
    );
  });

  it("rejects a single oversized retained draft", () => {
    const huge = "x".repeat(csvDraftCacheTestApi.limits.entryBytes);
    expect(setCsvDraft("huge.csv", draft(huge))).toBe(false);
    expect(getCsvDraft("huge.csv")).toBeNull();
    expect(csvDraftCacheTestApi.stats()).toEqual({ entries: 0, bytes: 0 });
  });

  it("accounts bytes when drafts are cleared", () => {
    setCsvDraft("a.csv", draft("value"));
    expect(csvDraftCacheTestApi.stats().bytes).toBeGreaterThan(0);
    clearCsvDraft("a.csv");
    expect(csvDraftCacheTestApi.stats()).toEqual({ entries: 0, bytes: 0 });
  });
});
