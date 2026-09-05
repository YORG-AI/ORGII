import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WorkstationTabIcon } from "@src/modules/WorkStation/shared/TabBar/components/WorkstationTabIcon";

import { RecentTabsMenuSection } from ".";

describe("RecentTabsMenuSection", () => {
  it("hides the section when the history is empty", () => {
    const markup = renderToStaticMarkup(
      createElement(RecentTabsMenuSection, {
        tabs: [],
        label: "Recent",
        onOpen: vi.fn(),
      })
    );

    expect(markup).toBe("");
  });

  it("renders bounded history entries as menu actions", () => {
    const markup = renderToStaticMarkup(
      createElement(RecentTabsMenuSection, {
        tabs: [
          {
            id: "tab-a",
            title: "Review",
            leadingIcon: createElement(WorkstationTabIcon, {
              tab: {
                id: "tab-a",
                type: "project-git-sync-review",
                title: "Review",
                icon: "GitMerge",
                data: {},
              },
              isActive: false,
            }),
          },
        ],
        label: "Recent",
        onOpen: vi.fn(),
      })
    );

    expect(markup).toContain('data-recent-tab-id="tab-a"');
    expect(markup).toContain('role="menuitem"');
    expect(markup).toContain("Review");
    expect(markup).toContain('data-icon="git-merge"');
    expect(markup).toContain("max-w-[320px]");
    expect(markup).toContain("truncate");
  });

  it("uses the file-type icon shown in the Workstation tab strip", () => {
    const markup = renderToStaticMarkup(
      createElement(RecentTabsMenuSection, {
        tabs: [
          {
            id: "file-a",
            title: "common.json",
            leadingIcon: createElement(WorkstationTabIcon, {
              tab: {
                id: "file-a",
                type: "file",
                title: "common.json",
                data: { filePath: "/repo/common.json" },
              },
              isActive: false,
            }),
          },
        ],
        label: "Recent",
        onOpen: vi.fn(),
      })
    );

    expect(markup).toContain('src="/src/assets/fileTypeIcons/json.svg"');
  });
});
