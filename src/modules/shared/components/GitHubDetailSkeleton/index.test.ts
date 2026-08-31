import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WORKSTATION_TRAIL_WIDTH } from "@src/modules/shared/layouts/blocks/WorkstationTrailSurface";

import GitHubDetailSkeleton from ".";

describe.each(["issue", "pr"] as const)(
  "GitHubDetailSkeleton %s loading state",
  (kind) => {
    it("keeps scrolling and reserves the real properties rail width", () => {
      const markup = renderToStaticMarkup(
        createElement(GitHubDetailSkeleton, { kind })
      );

      expect(markup).toContain("scrollbar-overlay");
      expect(markup).toContain("overflow-y-auto");
      expect(markup).toContain(
        `data-testid="github-${kind}-detail-skeleton-sidebar"`
      );
      expect(markup).toContain(`width:${WORKSTATION_TRAIL_WIDTH.expandedPx}px`);
      for (const label of kind === "pr"
        ? ["Reviewers", "Assignees", "Labels", "Actions"]
        : ["Work Item Properties", "Status", "Labels", "Assignment"]) {
        expect(markup).toContain(`>${label}</`);
      }
      expect(markup).not.toContain("No one assigned");
      expect(markup).not.toContain("None yet");
      expect(markup).not.toContain("border-l border-border-1");
      expect(markup).not.toContain("h-24 w-1 rounded-full");
    });
  }
);

describe("GitHubDetailSkeleton PR tabs", () => {
  it("shows actual tab labels and placeholders only for their counts", () => {
    const markup = renderToStaticMarkup(
      createElement(GitHubDetailSkeleton, { kind: "pr" })
    );

    for (const label of [
      "Conversation",
      "Commits",
      "Checks",
      "Files changed",
    ]) {
      expect(markup).toContain(`>${label}</span>`);
    }
    expect(
      markup.match(/data-testid="detail-tab-count-skeleton"/g)
    ).toHaveLength(4);
    expect(markup).not.toContain(
      'data-testid="github-pr-detail-skeleton-tabs"'
    );
    expect(markup).not.toContain(">0</span>");
  });

  it("omits navigation when the host owns the tab row", () => {
    const markup = renderToStaticMarkup(
      createElement(GitHubDetailSkeleton, {
        kind: "pr",
        showTabs: false,
      })
    );

    expect(markup).not.toContain('role="tablist"');
  });
});
