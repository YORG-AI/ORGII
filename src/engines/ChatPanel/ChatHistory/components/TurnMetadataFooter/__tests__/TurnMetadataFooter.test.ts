import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { TurnSummary } from "@src/engines/SessionCore/storage/sqliteCache";

import TurnMetadataFooter from "..";

vi.mock("@src/components/FileTypeIcon", () => ({
  default: () => null,
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
  });
});
