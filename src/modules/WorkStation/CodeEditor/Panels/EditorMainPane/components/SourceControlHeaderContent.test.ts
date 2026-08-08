import type { TFunction } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WorkStationTab } from "@src/store/workstation/tabs";

import { SourceControlHeaderContent } from "./SourceControlHeaderContent";

vi.mock("@src/components/Button", () => ({
  default: ({ title }: { title?: string }) =>
    createElement("button", { "data-title": title }),
}));

vi.mock("@src/components/TabPill", () => ({
  default: ({
    activeTab,
    tabs,
  }: {
    activeTab: string;
    tabs: Array<{ key: string }>;
  }) =>
    createElement("div", {
      "data-active-tab": activeTab,
      "data-tabs": tabs.map((tab) => tab.key).join(","),
    }),
}));

const t = ((key: string) => key) as TFunction;

function sourceControlTab(mode: "focus" | "all-changes"): WorkStationTab {
  return {
    id: "source-control:changes",
    type: "source-control",
    title: "Review",
    data: {
      mode,
      staged: false,
      fileCount: 1,
      focusPath: null,
      historySelection: null,
    },
  } as WorkStationTab;
}

function renderHeader(mode: "focus" | "all-changes"): string {
  return renderToStaticMarkup(
    createElement(SourceControlHeaderContent, {
      activeTab: sourceControlTab(mode),
      sourceControlFilterMode: "uncommitted",
      showSourceControlModePill: true,
      gitReviewNavigationTotal: 0,
      selectedIssue: null,
      sourceControlRefreshSpinClass: undefined,
      diffViewMode: "split",
      t,
      onDiffViewModeChange: vi.fn(),
      onModeChange: vi.fn(),
      onOpenHistoryInNewTab: vi.fn(),
      onReviewPrevFile: vi.fn(),
      onReviewNextFile: vi.fn(),
      onCollapseAll: vi.fn(),
      onRefresh: vi.fn(),
    })
  );
}

describe("SourceControlHeaderContent diff view controls", () => {
  it("shows the shared unified/split control in All Changes", () => {
    const markup = renderHeader("all-changes");

    expect(markup).toContain('data-active-tab="split"');
    expect(markup).toContain('data-tabs="unified,split"');
  });

  it("keeps the aggregate diff control out of Focus mode", () => {
    const markup = renderHeader("focus");

    expect(markup).not.toContain('data-tabs="unified,split"');
    expect(markup).toContain('data-tabs="focus,all-changes"');
  });
});
