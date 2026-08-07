import { describe, expect, it } from "vitest";

import type { TurnModifiedFile } from "@src/engines/SessionCore/storage/sqliteCache";

import { mapTurnModifiedFilesToFileChanges } from "../turnFilesMapping";

function file(overrides?: Partial<TurnModifiedFile>): TurnModifiedFile {
  return {
    path: "src/foo.ts",
    fileName: "foo.ts",
    status: "modified",
    additions: 3,
    deletions: 1,
    ...overrides,
  };
}

describe("mapTurnModifiedFilesToFileChanges", () => {
  it("keeps materialized order and line stats", () => {
    expect(
      mapTurnModifiedFilesToFileChanges([
        file(),
        file({ path: "src/bar.rs", fileName: "bar.rs", additions: 8 }),
      ])
    ).toMatchObject([
      { path: "src/foo.ts", additions: 3, deletions: 1 },
      { path: "src/bar.rs", additions: 8, deletions: 1 },
    ]);
  });

  it("derives missing names and drops unusable paths", () => {
    expect(
      mapTurnModifiedFilesToFileChanges([
        file({ path: "", fileName: "" }),
        file({ path: "src/deep/view.tsx", fileName: "" }),
      ])
    ).toMatchObject([{ path: "src/deep/view.tsx", fileName: "view.tsx" }]);
  });

  it("clamps malformed historical counts", () => {
    expect(
      mapTurnModifiedFilesToFileChanges([
        file({ additions: Number.NaN, deletions: -4 }),
      ])[0]
    ).toMatchObject({ additions: 0, deletions: 0 });
  });
});
