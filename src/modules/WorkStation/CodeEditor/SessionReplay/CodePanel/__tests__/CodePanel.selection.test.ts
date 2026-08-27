import { Provider } from "jotai";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { CodePanel } from "..";
import { FILE_OPERATION_TYPE, type FileOperationEntry } from "../../types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/engines/SessionCore/rendering/registry/initToolRegistry", () => ({
  getToolDisplayBehavior: () => "wait_for_result",
}));

vi.mock("@src/features/CodeViewer/VirtualizedModernDiff", () => ({
  VirtualizedModernDiff: () =>
    React.createElement("div", { "data-testid": "single-diff" }),
}));

vi.mock("@src/modules/shared/components/FileHeader", () => ({
  FileHeader: () => React.createElement("header"),
  default: () => React.createElement("header"),
}));

vi.mock("@src/modules/WorkStation/shared", () => ({
  NoTabsPlaceholder: () => React.createElement("div"),
  useSimulatorAwaitingAgentCaption: () => "Awaiting agent",
  useSimulatorPlaceholderActions: () => [],
}));

vi.mock("@src/modules/WorkStation/shared/SelectedTextAddToChat", () => ({
  SelectedTextAddToChat: ({
    children,
    displayName,
    scopeKey,
  }: {
    children?: React.ReactNode;
    displayName: string;
    scopeKey?: string | number;
  }) =>
    React.createElement(
      "div",
      {
        "data-selected-text-owner": displayName,
        "data-selection-scope": scopeKey,
      },
      children
    ),
}));

vi.mock("../CombinedDiffView", () => ({
  CombinedDiffView: () =>
    React.createElement("div", { "data-testid": "combined-diff" }),
}));

vi.mock("../useLiveReadFileContent", () => ({
  useLiveReadFileContent: () => ({ content: undefined, status: "idle" }),
}));

const EVENT: SessionEvent = {
  chunk_id: null,
  id: "event-1",
  sessionId: "session-1",
  createdAt: "2026-08-24T00:00:00.000Z",
  functionName: "edit_file",
  uiCanonical: "edit_file",
  actionType: "tool_call",
  args: {},
  result: {},
  source: "assistant",
  displayText: "Edit file",
  displayStatus: "completed",
  displayVariant: "tool_call",
  activityStatus: "agent",
};

function makeWriteOperation(
  overrides: Partial<FileOperationEntry> = {}
): FileOperationEntry {
  return {
    filePath: "/repo/src/example.ts",
    fileName: "example.ts",
    directory: "/repo/src",
    type: FILE_OPERATION_TYPE.WRITE,
    event: EVENT,
    eventId: "event-1",
    isCurrent: true,
    oldContent: "const before = 1;",
    newContent: "const after = 2;",
    ...overrides,
  };
}

function renderPanel(operation: FileOperationEntry): string {
  return renderToStaticMarkup(
    React.createElement(
      Provider,
      null,
      React.createElement(CodePanel, { operation })
    )
  );
}

describe("CodePanel selected-text ownership", () => {
  it("mounts the shared Add to Chat owner around a single edit diff", () => {
    const markup = renderPanel(makeWriteOperation());

    expect(markup).toContain('data-selected-text-owner="example.ts"');
    expect(markup).toContain('data-selection-scope="event-1"');
    expect(markup).toContain('data-testid="single-diff"');
  });

  it("mounts the same owner around combined edit diffs", () => {
    const first = makeWriteOperation({ eventId: "event-0", isCurrent: false });
    const current = makeWriteOperation({
      relatedOperations: [first, makeWriteOperation()],
    });
    const markup = renderPanel(current);

    expect(markup).toContain('data-selected-text-owner="example.ts"');
    expect(markup).toContain('data-selection-scope="event-1"');
    expect(markup).toContain('data-testid="combined-diff"');
  });
});
