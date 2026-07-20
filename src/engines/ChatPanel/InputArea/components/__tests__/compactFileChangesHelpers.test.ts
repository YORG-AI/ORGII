import { describe, expect, it } from "vitest";

import {
  type ChatRoundEvent,
  type EditArtifactLike,
  type FinalDiffLike,
  buildCompactFilesReloadKey,
  countChatRounds,
  mapEditArtifactsToFileChangeInfo,
  mapFinalDiffToFileChangeInfo,
  resolveFileChangeSummary,
  summarizeFileChanges,
} from "../compactFileChangesHelpers";

function createFinalDiff(overrides?: Partial<FinalDiffLike>): FinalDiffLike {
  return {
    filePath: "src/index.ts",
    isDeleted: false,
    linesAdded: 3,
    linesRemoved: 1,
    ...overrides,
  };
}

describe("mapFinalDiffToFileChangeInfo", () => {
  it("maps a modified diff to file-change info with derived totals", () => {
    expect(mapFinalDiffToFileChangeInfo(createFinalDiff())).toEqual({
      path: "src/index.ts",
      fileName: "index.ts",
      status: "M",
      additions: 3,
      deletions: 1,
      lineCount: 4,
    });
  });

  it("marks deleted files with the 'D' status", () => {
    const result = mapFinalDiffToFileChangeInfo(
      createFinalDiff({ isDeleted: true })
    );
    expect(result.status).toBe("D");
  });

  it("treats a missing isDeleted flag as a modification", () => {
    const result = mapFinalDiffToFileChangeInfo(
      createFinalDiff({ isDeleted: undefined })
    );
    expect(result.status).toBe("M");
  });

  it("extracts the basename from nested and Windows-style paths", () => {
    expect(
      mapFinalDiffToFileChangeInfo(createFinalDiff({ filePath: "a/b/c.tsx" }))
        .fileName
    ).toBe("c.tsx");
    expect(
      mapFinalDiffToFileChangeInfo(createFinalDiff({ filePath: "a\\b\\d.rs" }))
        .fileName
    ).toBe("d.rs");
  });

  it("sums additions and deletions into lineCount including zeros", () => {
    const result = mapFinalDiffToFileChangeInfo(
      createFinalDiff({ linesAdded: 0, linesRemoved: 0 })
    );
    expect(result.lineCount).toBe(0);
  });
});

function createEditArtifact(
  overrides?: Partial<EditArtifactLike>
): EditArtifactLike {
  return {
    filePath: "src/index.ts",
    editKind: "patch",
    linesAdded: 3,
    linesRemoved: 1,
    sequenceIndex: 1,
    ...overrides,
  };
}

describe("mapEditArtifactsToFileChangeInfo", () => {
  it("maps edit artifacts without requiring final diffs", () => {
    expect(mapEditArtifactsToFileChangeInfo([createEditArtifact()])).toEqual([
      {
        path: "src/index.ts",
        fileName: "index.ts",
        status: "M",
        additions: 3,
        deletions: 1,
        lineCount: 4,
      },
    ]);
  });

  it("groups artifacts by normalized file path and sums stats", () => {
    expect(
      mapEditArtifactsToFileChangeInfo([
        createEditArtifact({ filePath: "./src/index.ts", linesAdded: 2 }),
        createEditArtifact({ filePath: "a/src/index.ts", linesRemoved: 5 }),
        createEditArtifact({ filePath: "b/src/other.ts", linesAdded: 1 }),
      ])
    ).toEqual([
      {
        path: "src/index.ts",
        fileName: "index.ts",
        status: "M",
        additions: 5,
        deletions: 6,
        lineCount: 11,
      },
      {
        path: "src/other.ts",
        fileName: "other.ts",
        status: "M",
        additions: 1,
        deletions: 1,
        lineCount: 2,
      },
    ]);
  });

  it("uses the latest artifact status for deleted files", () => {
    const result = mapEditArtifactsToFileChangeInfo([
      createEditArtifact({ editKind: "patch", sequenceIndex: 1 }),
      createEditArtifact({ editKind: "delete", sequenceIndex: 2 }),
    ]);
    expect(result[0]?.status).toBe("D");
  });
});

describe("summarizeFileChanges", () => {
  it("sums actual per-file stats", () => {
    expect(
      summarizeFileChanges([
        mapFinalDiffToFileChangeInfo(createFinalDiff()),
        mapFinalDiffToFileChangeInfo(
          createFinalDiff({ filePath: "src/other.ts", linesAdded: 2 })
        ),
      ])
    ).toEqual({ count: 2, additions: 5, deletions: 2 });
  });

  it("returns a zero summary for no files", () => {
    expect(summarizeFileChanges([])).toEqual({
      count: 0,
      additions: 0,
      deletions: 0,
    });
  });

  it("uses explicit aggregate totals when per-file breakdown is unavailable", () => {
    const files = [
      mapFinalDiffToFileChangeInfo(
        createFinalDiff({ linesAdded: 0, linesRemoved: 0 })
      ),
    ];

    expect(
      resolveFileChangeSummary(files, {
        totalAdditions: 12,
        totalDeletions: 4,
      })
    ).toEqual({ count: 1, additions: 12, deletions: 4 });
  });
});

describe("countChatRounds", () => {
  function userEvent(displayText = "hello"): ChatRoundEvent {
    return { source: "user", displayText };
  }
  function assistantEvent(): ChatRoundEvent {
    return { source: "assistant", displayText: "working..." };
  }

  it("returns 0 for an empty event list", () => {
    expect(countChatRounds([])).toBe(0);
  });

  it("counts one round per user message with display text", () => {
    expect(
      countChatRounds([
        userEvent(),
        assistantEvent(),
        userEvent(),
        assistantEvent(),
      ])
    ).toBe(2);
  });

  it("ignores user events without display text (no false round boundary)", () => {
    expect(
      countChatRounds([
        userEvent(),
        { source: "user", displayText: "" },
        { source: "user", displayText: null },
        { source: "user", displayText: undefined },
      ])
    ).toBe(1);
  });

  it("ignores assistant and system events", () => {
    expect(
      countChatRounds([
        assistantEvent(),
        { source: "system", displayText: "boot" },
      ])
    ).toBe(0);
  });

  it("stays stable when assistant deltas grow mid-stream", () => {
    const before: ChatRoundEvent[] = [userEvent(), assistantEvent()];
    const after: ChatRoundEvent[] = [
      userEvent(),
      { source: "assistant", displayText: "working... more tokens" },
      { source: "assistant", displayText: "tool call" },
    ];
    expect(countChatRounds(before)).toBe(countChatRounds(after));
  });
});

describe("buildCompactFilesReloadKey", () => {
  it("matches the footer's sessionId:rounds:state shape", () => {
    expect(buildCompactFilesReloadKey("sess-1", 2, true)).toBe(
      "sess-1:2:working"
    );
    expect(buildCompactFilesReloadKey("sess-1", 2, false)).toBe(
      "sess-1:2:idle"
    );
  });

  it("changes when the session switches", () => {
    expect(buildCompactFilesReloadKey("a", 1, false)).not.toBe(
      buildCompactFilesReloadKey("b", 1, false)
    );
  });

  it("changes when a new round appears", () => {
    expect(buildCompactFilesReloadKey("a", 1, true)).not.toBe(
      buildCompactFilesReloadKey("a", 2, true)
    );
  });

  it("changes on the working -> idle transition (round complete)", () => {
    expect(buildCompactFilesReloadKey("a", 1, true)).not.toBe(
      buildCompactFilesReloadKey("a", 1, false)
    );
  });

  it("is identical across two streaming ticks of the same round", () => {
    // Same session, same round count, still working: no refetch should fire.
    expect(buildCompactFilesReloadKey("a", 1, true)).toBe(
      buildCompactFilesReloadKey("a", 1, true)
    );
  });

  it("normalizes a null session id to an empty segment", () => {
    expect(buildCompactFilesReloadKey(null, 0, false)).toBe(":0:idle");
  });
});
