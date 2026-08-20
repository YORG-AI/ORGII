import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { buildRemoteSessionWorkspaceFiles } from "../remoteSessionWorkspace";
import {
  resolveRemoteWorkspacePathForEvent,
  resolveRemoteWorkspaceSelectionPath,
} from "../remoteSessionWorkspaceSelection";

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

describe("resolveRemoteWorkspacePathForEvent", () => {
  it("returns the workspace-relative path for read and edit events", () => {
    const read = event("read", {
      functionName: "read_file",
      uiCanonical: "read_file",
      actionType: "tool_call",
      displayVariant: "tool_call",
      extracted: {
        kind: "file",
        filePath: "/repo/src/app.ts",
        fileName: "app.ts",
        language: "typescript",
        content: "const version = 1;",
      },
    });
    const edit = event("edit", {
      functionName: "edit_file_by_replace",
      uiCanonical: "edit_file",
      actionType: "tool_call",
      displayVariant: "tool_call",
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

    expect(resolveRemoteWorkspacePathForEvent(read)).toBe("src/app.ts");
    expect(resolveRemoteWorkspacePathForEvent(edit)).toBe("src/app.ts");
    expect(resolveRemoteWorkspacePathForEvent(event("msg"))).toBeNull();
  });
});

describe("resolveRemoteWorkspaceSelectionPath", () => {
  it("follows the replay cursor onto the active file event", () => {
    const read = event("read", {
      functionName: "read_file",
      uiCanonical: "read_file",
      actionType: "tool_call",
      displayVariant: "tool_call",
      extracted: {
        kind: "file",
        filePath: "/repo/src/read.ts",
        fileName: "read.ts",
        language: "typescript",
        content: "read me",
      },
    });
    const edit = event("edit", {
      createdAt: "2026-08-19T00:00:01.000Z",
      functionName: "edit_file_by_replace",
      uiCanonical: "edit_file",
      actionType: "tool_call",
      displayVariant: "tool_call",
      extracted: {
        kind: "edit",
        filePath: "/repo/src/edit.ts",
        fileName: "edit.ts",
        language: "typescript",
        oldContent: "a",
        newContent: "b",
        isDeleted: false,
        applyPatchSegments: [],
      },
    });
    const prefix = [read, event("msg"), edit];
    const files = buildRemoteSessionWorkspaceFiles(prefix);

    expect(
      resolveRemoteWorkspaceSelectionPath(prefix, files, "read", "src/edit.ts")
    ).toBe("src/read.ts");
    expect(
      resolveRemoteWorkspaceSelectionPath(prefix, files, "edit", "src/read.ts")
    ).toBe("src/edit.ts");
  });

  it("keeps manual selection when the replay cursor is not on a file event", () => {
    const read = event("read", {
      functionName: "read_file",
      uiCanonical: "read_file",
      actionType: "tool_call",
      displayVariant: "tool_call",
      extracted: {
        kind: "file",
        filePath: "/repo/src/read.ts",
        fileName: "read.ts",
        language: "typescript",
        content: "read me",
      },
    });
    const prefix = [read, event("msg")];
    const files = buildRemoteSessionWorkspaceFiles(prefix);

    expect(
      resolveRemoteWorkspaceSelectionPath(prefix, files, "msg", "src/read.ts")
    ).toBe("src/read.ts");
    expect(
      resolveRemoteWorkspaceSelectionPath(prefix, files, "msg", null)
    ).toBe("src/read.ts");
  });
});
