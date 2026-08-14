// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  TurnModifiedFile,
  TurnSummary,
} from "@src/engines/SessionCore/storage/sqliteCache";

import SessionChangesView from "./SessionChangesView";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { count?: number; defaultValue?: string }) =>
      options?.defaultValue?.replace(
        "{{count}}",
        String(options.count ?? "")
      ) ?? _key,
  }),
}));

vi.mock("@src/components/FileTypeIcon", () => ({
  default: ({ fileName, size }: { fileName: string; size: string }) =>
    React.createElement("span", {
      "data-testid": "file-type-icon",
      "data-file-name": fileName,
      "data-size": size,
    }),
}));

vi.mock("@src/components/TreeRow", () => ({
  VirtualizedListBase: <T>({
    items,
    itemHeight,
    paddingTop,
    computeItemKey,
    renderItem,
  }: {
    items: T[];
    itemHeight: number;
    paddingTop?: number;
    computeItemKey: (item: T, index: number) => string | number;
    renderItem: (item: T, index: number) => React.ReactNode;
  }) =>
    React.createElement(
      "div",
      {
        "data-testid": "virtualized-changes-list",
        "data-item-count": items.length,
        "data-item-height": itemHeight,
        "data-padding-top": paddingTop,
      },
      ...items
        .slice(0, 3)
        .map((item, index) =>
          React.createElement(
            React.Fragment,
            { key: computeItemKey(item, index) },
            renderItem(item, index)
          )
        )
    ),
}));

function file(index: number): TurnModifiedFile {
  const isBusiest = index === 0;
  return {
    path: isBusiest ? "src/important.tsx" : `src/file-${index}.ts`,
    fileName: isBusiest ? "important.tsx" : `file-${index}.ts`,
    status: "modified",
    additions: isBusiest ? 9 : 1,
    deletions: isBusiest ? 4 : 0,
  };
}

function turn(modifiedFiles: TurnModifiedFile[]): TurnSummary {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    startSequence: 1,
    endSequence: 2,
    nextTurnId: null,
    startedAt: "2026-08-14T00:00:00.000Z",
    endedAt: "2026-08-14T00:00:01.000Z",
    durationMs: 1_000,
    userEventIds: [],
    userPreview: "Update files",
    eventCount: 1,
    bodyEventCount: 1,
    status: "completed",
    interrupted: false,
    modifiedFiles,
    resourceInteractions: [],
    gitArtifacts: [],
  };
}

function renderView(
  modifiedFiles: TurnModifiedFile[],
  topInset?: number
): string {
  return renderToStaticMarkup(
    React.createElement(SessionChangesView, {
      turns: [turn(modifiedFiles)],
      loading: false,
      error: null,
      topInset,
    })
  );
}

describe("SessionChangesView", () => {
  it("keeps the full file collection virtualized", () => {
    document.body.innerHTML = renderView(
      Array.from({ length: 40 }, (_, index) => file(index))
    );

    const list = document.querySelector(
      '[data-testid="virtualized-changes-list"]'
    );
    expect(list?.getAttribute("data-item-count")).toBe("40");
    expect(list?.getAttribute("data-item-height")).toBe("34");
    expect(
      document.querySelectorAll('[data-testid="session-changes-row"]')
    ).toHaveLength(3);
  });

  it("uses a file-type icon and one diff-stat container per row", () => {
    document.body.innerHTML = renderView([file(0)]);

    const row = document.querySelector('[data-testid="session-changes-row"]');
    const icon = row?.querySelector('[data-testid="file-type-icon"]');
    const fileName = row?.querySelector(".text-text-1");
    const stats = row?.querySelector(
      '[data-testid="session-changes-diff-stats"]'
    );

    expect(icon?.getAttribute("data-file-name")).toBe("important.tsx");
    expect(icon?.getAttribute("data-size")).toBe("medium");
    expect(
      icon && fileName
        ? Boolean(
            icon.compareDocumentPosition(fileName) &
            Node.DOCUMENT_POSITION_FOLLOWING
          )
        : false
    ).toBe(true);
    expect(stats?.textContent).toContain("+9");
    expect(stats?.textContent).toContain("-4");
    expect(stats?.querySelectorAll(":scope > span")).toHaveLength(1);
  });

  it("keeps rows scrollable beneath the floating chat header", () => {
    document.body.innerHTML = renderView([file(0)], 84);

    const summary = document.querySelector(
      '[data-testid="session-changes-view-summary"]'
    );
    const list = document.querySelector(
      '[data-testid="virtualized-changes-list"]'
    );

    expect(summary?.className).toContain("bg-chat-pane/70");
    expect(summary?.className).toContain("backdrop-blur-xl");
    expect(summary?.getAttribute("style")).toContain("top:84px");
    expect(list?.getAttribute("data-padding-top")).toBe("116");
  });
});
