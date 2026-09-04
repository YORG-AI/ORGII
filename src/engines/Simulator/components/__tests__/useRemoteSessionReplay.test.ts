/** @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { createSmokeRoot } from "@src/test/reactSmokeHarness";

import { useRemoteSessionReplay } from "../useRemoteSessionReplay";

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

function ReplayProbe({
  events,
  currentEventId,
}: {
  events: SessionEvent[];
  currentEventId: string;
}) {
  const state = useRemoteSessionReplay({ events, currentEventId });
  return React.createElement("div", {
    "data-file-op-count": String(state.allFileOperations.length),
    "data-selected-file": state.selectedFileOperation?.fileName ?? "",
    "data-selected-event": state.selectedFileOperation?.eventId ?? "",
  });
}

describe("useRemoteSessionReplay", () => {
  const roots: Array<ReturnType<typeof createSmokeRoot>> = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => root.unmount()));
  });

  it("dedupes read operations like the desktop FileSidebar", async () => {
    const readA = event("read-a", {
      functionName: "read_file",
      uiCanonical: "read_file",
      actionType: "tool_call",
      displayVariant: "tool_call",
      args: { path: "/repo/src/hooks/useInlineWebview.ts" },
      extracted: {
        kind: "file",
        filePath: "/repo/src/hooks/useInlineWebview.ts",
        fileName: "useInlineWebview.ts",
        language: "typescript",
        content: "first",
      },
    });
    const readB = event("read-b", {
      createdAt: "2026-08-19T00:00:01.000Z",
      functionName: "read_file",
      uiCanonical: "read_file",
      actionType: "tool_call",
      displayVariant: "tool_call",
      args: { path: "/repo/src/hooks/useInlineWebview.ts" },
      extracted: {
        kind: "file",
        filePath: "/repo/src/hooks/useInlineWebview.ts",
        fileName: "useInlineWebview.ts",
        language: "typescript",
        content: "second",
      },
    });

    const root = createSmokeRoot();
    roots.push(root);
    await root.render(
      React.createElement(ReplayProbe, {
        events: [readA, readB],
        currentEventId: "read-b",
      })
    );

    const probe = root.container.firstElementChild;
    expect(probe?.getAttribute("data-file-op-count")).toBe("1");
    expect(probe?.getAttribute("data-selected-file")).toBe(
      "useInlineWebview.ts"
    );
    expect(probe?.getAttribute("data-selected-event")).toBe("read-b");
  });
});
