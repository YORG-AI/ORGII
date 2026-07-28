import {
  type XlsxDraftEntry,
  clearXlsxDraft,
  getXlsxDraft,
  setXlsxDraft,
  xlsxDraftCacheTestApi,
} from "../xlsxDraftCache";

function createDraftEntry(label: string): XlsxDraftEntry {
  return {
    sheetInfos: [
      {
        name: `Sheet ${label}`,
        rowCount: 2,
        columnCount: 2,
      },
    ],
    sheetStates: {
      [`Sheet ${label}`]: {
        rows: [
          [`${label}-a1`, `${label}-b1`],
          [`${label}-a2`, `${label}-b2`],
        ],
        originalRows: [
          [`${label}-original-a1`, `${label}-original-b1`],
          [`${label}-original-a2`, `${label}-original-b2`],
        ],
        patches: [
          {
            sheetName: `Sheet ${label}`,
            rowIndex: 1,
            columnIndex: 1,
            value: `${label}-patched`,
          },
        ],
        nextRow: 2,
        hasMoreRows: false,
      },
    },
    activeSheet: 0,
  };
}

function clearDrafts(filePaths: string[]): void {
  filePaths.forEach((filePath) => clearXlsxDraft(filePath));
}

describe("xlsxDraftCache", () => {
  const filePaths = Array.from(
    { length: 60 },
    (_unused, index) => `/tmp/xlsx-draft-cache-${index}.xlsx`
  );

  afterEach(() => {
    clearDrafts(filePaths);
    xlsxDraftCacheTestApi.clear();
  });

  it("returns null when a file has no draft", () => {
    expect(getXlsxDraft(filePaths[0])).toBeNull();
  });

  it("stores and clears drafts by file path", () => {
    setXlsxDraft(filePaths[0], createDraftEntry("stored"));

    expect(getXlsxDraft(filePaths[0])?.sheetInfos[0]?.name).toBe(
      "Sheet stored"
    );

    clearXlsxDraft(filePaths[0]);

    expect(getXlsxDraft(filePaths[0])).toBeNull();
  });

  it("isolates stored drafts from later input mutations", () => {
    const entry = createDraftEntry("input");

    setXlsxDraft(filePaths[0], entry);

    entry.sheetInfos[0].name = "Mutated sheet";
    entry.sheetStates["Sheet input"].rows[0][0] = "mutated row";
    entry.sheetStates["Sheet input"].originalRows[0][0] = "mutated original";
    entry.sheetStates["Sheet input"].patches[0].value = "mutated patch";
    entry.activeSheet = 4;

    const stored = getXlsxDraft(filePaths[0]);

    expect(stored?.sheetInfos[0]?.name).toBe("Sheet input");
    expect(stored?.sheetStates["Sheet input"].rows[0][0]).toBe("input-a1");
    expect(stored?.sheetStates["Sheet input"].originalRows[0][0]).toBe(
      "input-original-a1"
    );
    expect(stored?.sheetStates["Sheet input"].patches[0].value).toBe(
      "input-patched"
    );
    expect(stored?.activeSheet).toBe(0);
  });

  it("isolates cached drafts from mutations to returned values", () => {
    setXlsxDraft(filePaths[0], createDraftEntry("returned"));

    const firstRead = getXlsxDraft(filePaths[0]);
    expect(firstRead).not.toBeNull();

    if (!firstRead) return;

    firstRead.sheetInfos[0].name = "Mutated returned sheet";
    firstRead.sheetStates["Sheet returned"].rows[0][0] = "mutated row";
    firstRead.sheetStates["Sheet returned"].originalRows[0][0] =
      "mutated original";
    firstRead.sheetStates["Sheet returned"].patches[0].value = "mutated patch";
    firstRead.activeSheet = 3;

    const secondRead = getXlsxDraft(filePaths[0]);

    expect(secondRead?.sheetInfos[0]?.name).toBe("Sheet returned");
    expect(secondRead?.sheetStates["Sheet returned"].rows[0][0]).toBe(
      "returned-a1"
    );
    expect(secondRead?.sheetStates["Sheet returned"].originalRows[0][0]).toBe(
      "returned-original-a1"
    );
    expect(secondRead?.sheetStates["Sheet returned"].patches[0].value).toBe(
      "returned-patched"
    );
    expect(secondRead?.activeSheet).toBe(0);
  });

  it("evicts the oldest draft when the cache reaches its maximum size", () => {
    filePaths.slice(0, 50).forEach((filePath, index) => {
      setXlsxDraft(filePath, createDraftEntry(`entry-${index}`));
    });

    setXlsxDraft(filePaths[50], createDraftEntry("newest"));

    expect(getXlsxDraft(filePaths[0])).toBeNull();
    expect(getXlsxDraft(filePaths[1])?.sheetInfos[0]?.name).toBe(
      "Sheet entry-1"
    );
    expect(getXlsxDraft(filePaths[50])?.sheetInfos[0]?.name).toBe(
      "Sheet newest"
    );
  });

  it("refreshes draft recency when a draft is read", () => {
    filePaths.slice(0, 50).forEach((filePath, index) => {
      setXlsxDraft(filePath, createDraftEntry(`entry-${index}`));
    });

    expect(getXlsxDraft(filePaths[0])?.sheetInfos[0]?.name).toBe(
      "Sheet entry-0"
    );

    setXlsxDraft(filePaths[50], createDraftEntry("newest"));

    expect(getXlsxDraft(filePaths[0])?.sheetInfos[0]?.name).toBe(
      "Sheet entry-0"
    );
    expect(getXlsxDraft(filePaths[1])).toBeNull();
  });

  it("refreshes draft recency when an existing draft is replaced", () => {
    filePaths.slice(0, 50).forEach((filePath, index) => {
      setXlsxDraft(filePath, createDraftEntry(`entry-${index}`));
    });

    setXlsxDraft(filePaths[0], createDraftEntry("replacement"));
    setXlsxDraft(filePaths[50], createDraftEntry("newest"));

    expect(getXlsxDraft(filePaths[0])?.sheetInfos[0]?.name).toBe(
      "Sheet replacement"
    );
    expect(getXlsxDraft(filePaths[1])).toBeNull();
  });

  it("rejects a single draft above the byte budget", () => {
    const entry = createDraftEntry("oversized");
    entry.sheetStates["Sheet oversized"].rows = [
      ["x".repeat(xlsxDraftCacheTestApi.limits.entryBytes)],
    ];

    expect(setXlsxDraft(filePaths[0], entry)).toBe(false);
    expect(getXlsxDraft(filePaths[0])).toBeNull();
    expect(xlsxDraftCacheTestApi.stats()).toEqual({ entries: 0, bytes: 0 });
  });

  it("releases retained bytes when a draft is cleared", () => {
    setXlsxDraft(filePaths[0], createDraftEntry("bytes"));
    expect(xlsxDraftCacheTestApi.stats().bytes).toBeGreaterThan(0);

    clearXlsxDraft(filePaths[0]);
    expect(xlsxDraftCacheTestApi.stats()).toEqual({ entries: 0, bytes: 0 });
  });
});
