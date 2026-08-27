import { describe, expect, it } from "vitest";

import { FILE_OPERATION_TYPE, type FileOperationEntry } from "../types";
import { buildReadFileKey, buildWriteFileKey } from "../utils/fileOpUtils";

/**
 * `readItems` / `writeItems` in FileSidebar are memoized on these keys instead
 * of on the operation arrays, whose identity churns on every replay step. The
 * invariant under test: the key must change whenever any field the projection
 * renders changes. `filePath` used to be rendered but not encoded, which froze
 * the sidebar tree on a streaming `apply_patch` "Add File" -- the path is
 * parsed out of the patch blob and grows character-by-character while the event
 * id, timestamp, edit count and A/M baseline flag all stay fixed.
 */

function writeOp(overrides: Partial<FileOperationEntry> = {}) {
  return {
    eventId: "evt-1",
    type: FILE_OPERATION_TYPE.WRITE,
    filePath: "src/foo/NewThing.tsx",
    fileName: "NewThing.tsx",
    writeHasBaselineContent: false,
    editCount: 1,
    event: { createdAt: "2026-08-23T00:00:00Z" },
    ...overrides,
  } as unknown as FileOperationEntry;
}

function readOp(overrides: Partial<FileOperationEntry> = {}) {
  return {
    eventId: "evt-1",
    type: FILE_OPERATION_TYPE.READ,
    filePath: "src/foo/NewThing.tsx",
    fileName: "NewThing.tsx",
    event: { createdAt: "2026-08-23T00:00:00Z" },
    ...overrides,
  } as unknown as FileOperationEntry;
}

describe("buildWriteFileKey", () => {
  it("changes when only filePath changes (streaming Add File regression)", () => {
    // Exactly the observed sequence: the path completes mid-stream while every
    // other encoded field holds still.
    const truncated = buildWriteFileKey([
      writeOp({ filePath: "src/foo/New", fileName: "New" }),
    ]);
    const complete = buildWriteFileKey([writeOp()]);

    expect(truncated).not.toBe(complete);
  });

  it("changes when the A/M baseline flag flips", () => {
    expect(
      buildWriteFileKey([writeOp({ writeHasBaselineContent: true })])
    ).not.toBe(
      buildWriteFileKey([writeOp({ writeHasBaselineContent: false })])
    );
  });

  it("changes when editCount changes", () => {
    expect(buildWriteFileKey([writeOp({ editCount: 2 })])).not.toBe(
      buildWriteFileKey([writeOp({ editCount: 1 })])
    );
  });

  it("encodes deletes distinctly from writes at the same path", () => {
    expect(
      buildWriteFileKey([writeOp({ type: FILE_OPERATION_TYPE.DELETE })])
    ).not.toBe(buildWriteFileKey([writeOp()]));
  });

  it("is stable when nothing rendered changes", () => {
    expect(buildWriteFileKey([writeOp()])).toBe(buildWriteFileKey([writeOp()]));
  });

  it("does not collide for paths containing the old delimiters", () => {
    // The previous key joined `:`-delimited segments with `,`. A path may
    // legitimately contain both, so the key is JSON-encoded instead.
    expect(
      buildWriteFileKey([
        writeOp({ filePath: "a:1,b" }),
        writeOp({ filePath: "c" }),
      ])
    ).not.toBe(
      buildWriteFileKey([
        writeOp({ filePath: "a" }),
        writeOp({ filePath: "1,b:c" }),
      ])
    );
  });
});

describe("buildReadFileKey", () => {
  it("changes when only filePath changes", () => {
    expect(buildReadFileKey([readOp({ filePath: "src/foo/New" })])).not.toBe(
      buildReadFileKey([readOp()])
    );
  });

  it("is stable when nothing rendered changes", () => {
    expect(buildReadFileKey([readOp()])).toBe(buildReadFileKey([readOp()]));
  });

  it("does not collide for paths containing the old delimiters", () => {
    expect(
      buildReadFileKey([
        readOp({ filePath: "a:1,b" }),
        readOp({ filePath: "c" }),
      ])
    ).not.toBe(
      buildReadFileKey([
        readOp({ filePath: "a" }),
        readOp({ filePath: "1,b:c" }),
      ])
    );
  });
});
