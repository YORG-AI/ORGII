import { describe, expect, it } from "vitest";

import type { GitWorkingDirectoryFile } from "@src/api/http/git";
import {
  baseFileListIdentity,
  deriveBaseFiles,
  deriveBaseFilesFromIdentity,
} from "@src/modules/WorkStation/CodeEditor/hooks/sourceControl/gitFilesDerivation";

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

describe("baseFileListIdentity", () => {
  it("is stable for structurally identical status payloads", () => {
    expect(baseFileListIdentity([createStatusFile()])).toBe(
      baseFileListIdentity([createStatusFile()])
    );
  });

  it.each<[string, Partial<GitWorkingDirectoryFile>]>([
    ["path", { path: "src/other.ts" }],
    ["status", { status: "D" }],
    ["staged", { staged: true }],
    ["rename source", { original_path: "src/old.ts" }],
  ])("changes when %s changes", (_label, overrides) => {
    expect(baseFileListIdentity([createStatusFile(overrides)])).not.toBe(
      baseFileListIdentity([createStatusFile()])
    );
  });

  it("distinguishes an omitted rename source from explicit null", () => {
    expect(
      baseFileListIdentity([createStatusFile({ original_path: undefined })])
    ).not.toBe(baseFileListIdentity([createStatusFile()]));
  });

  it("round-trips every field consumed by the derivation", () => {
    const statusFiles = [
      createStatusFile({
        path: "src/renamed.ts",
        status: "R",
        staged: true,
        original_path: "src/original.ts",
      }),
    ];
    expect(
      deriveBaseFilesFromIdentity(baseFileListIdentity(statusFiles))
    ).toEqual(deriveBaseFiles(statusFiles));
  });
});
