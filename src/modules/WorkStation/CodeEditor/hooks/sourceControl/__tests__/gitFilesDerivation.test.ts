import { describe, expect, it } from "vitest";

import type { GitWorkingDirectoryFile } from "@src/api/http/git";
import {
  areBaseFileListsEqual,
  deriveBaseFiles,
} from "@src/modules/WorkStation/CodeEditor/hooks/sourceControl/gitFilesDerivation";
import type { GitFile } from "@src/types/git/types";

function createStatusFile(
  overrides: Partial<GitWorkingDirectoryFile> = {}
): GitWorkingDirectoryFile {
  return {
    path: "src/index.ts",
    status: "M",
    staged: false,
    original_path: null,
    ...overrides,
  } as GitWorkingDirectoryFile;
}

function createGitFile(overrides: Partial<GitFile> = {}): GitFile {
  return {
    id: "src/index.ts-0",
    path: "src/index.ts",
    status: "modified",
    additions: 0,
    deletions: 0,
    staged: false,
    original_path: null,
    ...overrides,
  };
}

describe("deriveBaseFiles", () => {
  it("returns an empty list for empty input", () => {
    expect(deriveBaseFiles([])).toEqual([]);
  });

  it("maps working-directory files into GitFile shape with index-based ids", () => {
    const result = deriveBaseFiles([
      createStatusFile({ path: "a.ts", staged: true }),
      createStatusFile({ path: "b.ts", staged: false }),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: "a.ts-0",
      path: "a.ts",
      staged: true,
    });
    expect(result[1]).toMatchObject({
      id: "b.ts-1",
      path: "b.ts",
      staged: false,
    });
    expect(result[0].oldContent).toBeUndefined();
  });
});

describe("areBaseFileListsEqual", () => {
  it("returns true for the same array reference", () => {
    const list = [createGitFile()];
    expect(areBaseFileListsEqual(list, list)).toBe(true);
  });

  it("returns true for two structurally identical (byte-identical) lists", () => {
    expect(areBaseFileListsEqual([createGitFile()], [createGitFile()])).toBe(
      true
    );
  });

  it("returns false when lengths differ", () => {
    expect(
      areBaseFileListsEqual(
        [createGitFile()],
        [createGitFile(), createGitFile({ id: "b-1", path: "b.ts" })]
      )
    ).toBe(false);
  });

  it("returns false when a staged flag changes (cannot stick stale)", () => {
    expect(
      areBaseFileListsEqual(
        [createGitFile({ staged: false })],
        [createGitFile({ staged: true })]
      )
    ).toBe(false);
  });

  it("returns false when status changes", () => {
    expect(
      areBaseFileListsEqual(
        [createGitFile({ status: "modified" })],
        [createGitFile({ status: "deleted" })]
      )
    ).toBe(false);
  });

  it("returns false when path/id changes", () => {
    expect(
      areBaseFileListsEqual(
        [createGitFile({ id: "a-0", path: "a.ts" })],
        [createGitFile({ id: "b-0", path: "b.ts" })]
      )
    ).toBe(false);
  });

  it("returns false when original_path (rename source) changes", () => {
    expect(
      areBaseFileListsEqual(
        [createGitFile({ original_path: null })],
        [createGitFile({ original_path: "old.ts" })]
      )
    ).toBe(false);
  });

  it("ignores non-identity fields like additions/deletions for the gate", () => {
    expect(
      areBaseFileListsEqual(
        [createGitFile({ additions: 0, deletions: 0 })],
        [createGitFile({ additions: 5, deletions: 3 })]
      )
    ).toBe(true);
  });

  it("handles two empty lists as equal", () => {
    expect(areBaseFileListsEqual([], [])).toBe(true);
  });
});
