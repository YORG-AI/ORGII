import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { TurnSummary } from "@src/engines/SessionCore/storage/sqliteCache";

import TurnMetadataFooter from "..";

vi.mock("@src/components/FileTypeIcon", () => ({
  default: ({ size }: { size?: string }) =>
    React.createElement("span", {
      "data-testid": "file-type-icon",
      "data-size": size,
    }),
}));

const BASE_SUMMARY: TurnSummary = {
  sessionId: "session-1",
  turnId: "turn-1",
  startSequence: 1,
  endSequence: 2,
  nextTurnId: null,
  startedAt: "2026-07-23T00:00:00.000Z",
  endedAt: "2026-07-23T00:00:01.000Z",
  durationMs: 1000,
  userEventIds: [],
  userPreview: "",
  eventCount: 1,
  bodyEventCount: 1,
  status: "completed",
  interrupted: false,
  modifiedFiles: [],
  resourceInteractions: [],
  gitArtifacts: [],
};

function renderFooter(summary: TurnSummary): string {
  return renderToStaticMarkup(
    React.createElement(TurnMetadataFooter, {
      summary,
      sessionId: summary.sessionId,
      turnId: summary.turnId,
    })
  );
}

describe("TurnMetadataFooter tabs", () => {
  it("hides Reads when the turn only contains edits", () => {
    const markup = renderFooter({
      ...BASE_SUMMARY,
      modifiedFiles: [
        {
          path: "src/app.ts",
          fileName: "app.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
        },
      ],
    });

    expect(markup).toContain('data-testid="turn-metadata-edits-tab"');
    expect(markup).not.toContain('data-testid="turn-metadata-reads-tab"');
    expect(markup).not.toContain("lucide-file-code-2");
  });

  it("hides Edits when the turn only contains reads", () => {
    const markup = renderFooter({
      ...BASE_SUMMARY,
      resourceInteractions: [
        {
          path: "src/app.ts",
          fileName: "app.ts",
          action: "read",
          outcome: "succeeded",
          count: 1,
          firstOccurredAt: "2026-07-23T00:00:00.000Z",
          lastOccurredAt: "2026-07-23T00:00:00.000Z",
        },
      ],
    });

    expect(markup).not.toContain('data-testid="turn-metadata-edits-tab"');
    expect(markup).toContain('data-testid="turn-metadata-reads-tab"');
    expect(markup).not.toContain("lucide-book-open-text");
    expect(markup).toContain("flex gap-1.5 items-baseline");
  });

  it("keeps the larger expansion control pinned outside the hidden-scroll list", () => {
    const summary: TurnSummary = {
      ...BASE_SUMMARY,
      resourceInteractions: Array.from({ length: 6 }, (_, index) => ({
        path: `src/file-${index + 1}.ts`,
        fileName: `file-${index + 1}.ts`,
        action: "read" as const,
        outcome: "succeeded" as const,
        count: 1,
        firstOccurredAt: "2026-07-23T00:00:00.000Z",
        lastOccurredAt: "2026-07-23T00:00:00.000Z",
      })),
    };
    const markup = renderFooter(summary);
    const scrollAreaIndex = markup.indexOf(
      'data-testid="turn-metadata-scroll-area"'
    );
    const lastVisibleReadIndex = markup.lastIndexOf(
      'data-testid="turn-metadata-read"'
    );
    const pinnedControlsIndex = markup.indexOf(
      'data-testid="turn-metadata-pinned-controls"'
    );

    expect(markup).toContain("min-h-0 flex-1 overflow-y-auto scrollbar-hide");
    expect(
      markup.match(/data-testid="turn-metadata-read"/g) ?? []
    ).toHaveLength(4);
    expect(scrollAreaIndex).toBeGreaterThanOrEqual(0);
    expect(lastVisibleReadIndex).toBeGreaterThan(scrollAreaIndex);
    expect(pinnedControlsIndex).toBeGreaterThan(lastVisibleReadIndex);
    expect(markup).toContain('data-testid="turn-metadata-expansion-toggle"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('data-size="medium"');
    expect(markup).toContain('class="lucide lucide-ellipsis');
    expect(markup).toContain('width="16"');
  });
});
