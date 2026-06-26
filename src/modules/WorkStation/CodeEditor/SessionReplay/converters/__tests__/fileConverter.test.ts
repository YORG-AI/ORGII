/**
 * File converter: path parsing and SessionEvent → FileOperationEntry.
 */
import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { convertToFileOperation, parseFilePath } from "../fileConverter";

function minimalSessionEvent(
  overrides: Partial<SessionEvent> = {}
): SessionEvent {
  return {
    chunk_id: null,
    id: "evt-1",
    sessionId: "sess-1",
    createdAt: "2026-03-29T12:00:00.000Z",
    functionName: "read_file",
    uiCanonical: "",
    actionType: "tool_call",
    args: {},
    result: {},
    source: "assistant",
    displayText: "",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "agent",
    ...overrides,
  };
}

describe("parseFilePath", () => {
  it("splits directory and file name", () => {
    expect(parseFilePath("/proj/src/app.ts")).toEqual({
      fileName: "app.ts",
      directory: "/proj/src",
    });
  });

  it("uses root directory when path is a single segment", () => {
    expect(parseFilePath("file.ts")).toEqual({
      fileName: "file.ts",
      directory: "/",
    });
  });
});

describe("convertToFileOperation", () => {
  it("builds a read operation when extractFileData finds a path", () => {
    const event = minimalSessionEvent({
      id: "read-1",
      functionName: "read_file",
      args: { path: "/repo/x.ts" },
      result: {
        success: {
          path: "/repo/x.ts",
          content: "hello",
        },
      },
    });

    const op = convertToFileOperation(event, true);
    expect(op).not.toBeNull();
    expect(op?.type).toBe("read");
    expect(op?.filePath).toBe("/repo/x.ts");
    expect(op?.content).toBe("hello");
    expect(op?.isCurrent).toBe(true);
  });

  it("builds a loading read operation from running args before result arrives", () => {
    const event = minimalSessionEvent({
      id: "read-running",
      functionName: "read_file",
      args: { path: "/repo/loading.ts" },
      result: {},
      displayStatus: "running",
    });

    const op = convertToFileOperation(event, true);

    expect(op).not.toBeNull();
    expect(op?.type).toBe("read");
    expect(op?.filePath).toBe("/repo/loading.ts");
    expect(op?.content).toBeUndefined();
    expect(op?.isLoading).toBe(true);
    expect(op?.isCurrent).toBe(true);
  });

  it("builds a loading write operation from streamed create-file args", () => {
    const event = minimalSessionEvent({
      id: "create-running",
      functionName: "create_file",
      uiCanonical: "edit_file",
      args: {
        file_path: "src/new.ts",
        streamContent: "export const created = true;",
        content: "export const created = true;",
      },
      result: {},
      displayStatus: "running",
      filePath: "src/new.ts",
      isDelta: true,
    });

    const op = convertToFileOperation(event, true);

    expect(op).not.toBeNull();
    expect(op?.type).toBe("write");
    expect(op?.filePath).toBe("src/new.ts");
    expect(op?.newContent).toBe("export const created = true;");
    expect(op?.isLoading).toBe(true);
  });

  it("builds a loading write operation from streamed edit args", () => {
    const event = minimalSessionEvent({
      id: "edit-running",
      functionName: "edit_file",
      args: {
        file_path: "src/app.ts",
        streamContent: "const live = true;",
        new_string: "const live = true;",
      },
      result: { status: "running" },
      displayStatus: "running",
      filePath: "src/app.ts",
      isDelta: true,
    });

    const op = convertToFileOperation(event, true);

    expect(op).not.toBeNull();
    expect(op?.type).toBe("write");
    expect(op?.filePath).toBe("src/app.ts");
    expect(op?.newContent).toBe("const live = true;");
    expect(op?.isLoading).toBe(true);
  });

  it("preserves hunk line numbers from Rust edit diffs", () => {
    const event = minimalSessionEvent({
      id: "edit-1",
      functionName: "edit_file",
      args: {
        file_path: "src/foo.ts",
        old_string: "old",
        new_string: "new",
      },
      result: {
        content:
          "Edit applied to src/foo.ts\n\n```diff\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -13,3 +13,3 @@\n context\n-old\n+new\n```",
      },
    });

    const op = convertToFileOperation(event, true);

    expect(op).not.toBeNull();
    expect(op?.type).toBe("write");
    expect(op?.oldStartLine).toBe(13);
    expect(op?.newStartLine).toBe(13);
    expect(op?.oldContent).toBe("context\nold");
    expect(op?.newContent).toBe("context\nnew");
  });

  it("returns null when file path cannot be resolved", () => {
    const event = minimalSessionEvent({
      functionName: "read_file",
      args: {},
      result: {},
    });
    expect(convertToFileOperation(event, false)).toBeNull();
  });
});
