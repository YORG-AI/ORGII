import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { buildRemoteSessionWorkspaceFiles } from "./remoteSessionWorkspace";

function event(
  id: string,
  overrides: Partial<SessionEvent> = {}
): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId: "remote-session",
    createdAt: "2026-08-19T00:00:00.000Z",
    functionName: "message",
    uiCanonical: "message",
    actionType: "message",
    args: {},
    result: {},
    source: "assistant",
    displayText: id,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    repoPath: "/repo",
    ...overrides,
  } as SessionEvent;
}

describe("buildRemoteSessionWorkspaceFiles", () => {
  it("uses the latest event-backed file state without inventing untouched files", () => {
    const read = event("read", {
      functionName: "read_file",
      uiCanonical: "read_file",
      actionType: "tool_call",
      displayVariant: "tool_call",
      filePath: "/repo/src/app.ts",
      extracted: {
        kind: "file",
        filePath: "/repo/src/app.ts",
        fileName: "app.ts",
        language: "typescript",
        content: "const version = 1;",
      },
    });
    const edit = event("edit", {
      createdAt: "2026-08-19T00:00:01.000Z",
      functionName: "edit_file_by_replace",
      uiCanonical: "edit_file",
      actionType: "tool_call",
      displayVariant: "tool_call",
      filePath: "/repo/src/app.ts",
      extracted: {
        kind: "edit",
        filePath: "/repo/src/app.ts",
        fileName: "app.ts",
        language: "typescript",
        oldContent: "const version = 1;",
        newContent: "const version = 2;",
        isDeleted: false,
        applyPatchSegments: [],
      },
    });

    const files = buildRemoteSessionWorkspaceFiles([
      edit,
      event("message"),
      read,
    ]);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: "src/app.ts",
      fileName: "app.ts",
      eventId: "edit",
      mode: "diff",
      status: "modified",
      oldContent: "const version = 1;",
      newContent: "const version = 2;",
      partial: true,
    });
  });

  it("marks ranged reads as partial and paths without bodies as unavailable", () => {
    const rangedRead = event("ranged", {
      functionName: "read_file",
      uiCanonical: "read_file",
      actionType: "tool_call",
      displayVariant: "tool_call",
      args: { path: "/repo/src/ranged.ts", offset: 10, limit: 20 },
      extracted: {
        kind: "file",
        filePath: "/repo/src/ranged.ts",
        fileName: "ranged.ts",
        language: "typescript",
        content: "line eleven",
        startLine: 11,
      },
    });
    const missingBody = event("missing", {
      functionName: "read_file",
      uiCanonical: "read_file",
      actionType: "tool_call",
      displayVariant: "tool_call",
      filePath: "/repo/src/missing.ts",
      extracted: {
        kind: "file",
        filePath: "/repo/src/missing.ts",
        fileName: "missing.ts",
        language: "typescript",
      },
    });

    const files = buildRemoteSessionWorkspaceFiles([rangedRead, missingBody]);

    expect(files.find((file) => file.path === "src/ranged.ts")).toMatchObject({
      mode: "content",
      content: "line eleven",
      contentStartLine: 11,
      partial: true,
    });
    expect(files.find((file) => file.path === "src/missing.ts")).toMatchObject({
      mode: "unavailable",
      status: "unavailable",
    });
  });
});
