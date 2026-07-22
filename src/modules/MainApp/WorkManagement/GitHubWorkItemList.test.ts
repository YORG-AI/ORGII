import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  GitHubWorkItemSearch,
  GitHubWorkItemStateTabs,
  GitHubWorkItemTableSurface,
  GitHubWorkItemToolbarActions,
  shouldUseSingleRowGitHubWorkItemsHeader,
} from "./GitHubWorkItemList";

describe("shouldUseSingleRowGitHubWorkItemsHeader", () => {
  it("combines controls and search only when the surface is wide enough", () => {
    expect(shouldUseSingleRowGitHubWorkItemsHeader(649)).toBe(false);
    expect(shouldUseSingleRowGitHubWorkItemsHeader(650)).toBe(true);
  });
});

describe("GitHubWorkItemTableSurface", () => {
  it("caps GitHub issue and PR tables at the standard panel width", () => {
    const markup = renderToStaticMarkup(
      createElement(GitHubWorkItemTableSurface, null, "Table")
    );

    expect(markup).toContain("mx-auto w-full max-w-[932px]");
  });
});

describe("GitHubWorkItemSearch", () => {
  it("fills the available width in either responsive header row", () => {
    const markup = renderToStaticMarkup(
      createElement(GitHubWorkItemSearch, {
        value: "is:issue is:open",
        placeholder: "Search issues",
        onChange: vi.fn(),
      })
    );

    expect(markup).toContain("min-w-0 flex-1");
    expect(markup).toContain('aria-label="Search issues"');
  });
});

describe("GitHubWorkItemToolbarActions", () => {
  it("renders Refresh before the compact SquarePen create action", () => {
    const markup = renderToStaticMarkup(
      createElement(GitHubWorkItemToolbarActions, {
        refreshLabel: "Refresh",
        refreshing: false,
        createAction: {
          label: "Create issue",
          disabled: false,
          onClick: vi.fn(),
        },
        onRefresh: vi.fn(),
      })
    );

    expect(markup.indexOf('aria-label="Refresh"')).toBeLessThan(
      markup.indexOf('aria-label="Create issue"')
    );
    expect(markup).toContain('class="lucide lucide-square-pen"');
    expect(markup).toContain('width="14"');
    expect(markup).toContain('height="14"');
  });
});

describe("GitHubWorkItemStateTabs", () => {
  it("renders accessible icon-only Open and Closed controls", () => {
    const markup = renderToStaticMarkup(
      createElement(GitHubWorkItemStateTabs, {
        activeTab: "open",
        onChange: vi.fn(),
        tabs: [
          {
            key: "open",
            label: "Open",
          },
          {
            key: "closed",
            label: "Closed",
          },
        ],
      })
    );

    expect(markup).toContain('data-testid="github-work-items-state-open"');
    expect(markup).toContain('data-testid="github-work-items-state-closed"');
    expect(markup).toContain("lucide-circle-dot");
    expect(markup).toContain("lucide-circle-check");
    expect(markup).toContain("text-success-6");
    expect(markup).toContain("text-purple-6");
    expect(markup).toContain('class="sr-only">Open</span>');
    expect(markup).toContain('class="sr-only">Closed</span>');
    expect(markup).toContain("rounded-lg border border-border-2 bg-bg-2 p-0.5");
    expect(markup).toContain('style="height:28px"');
  });
});
