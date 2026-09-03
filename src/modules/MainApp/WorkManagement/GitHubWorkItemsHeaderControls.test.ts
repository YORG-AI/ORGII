import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  GitHubWorkItemsHeaderControls,
  GitHubWorkItemsRepositorySelect,
} from "./GitHubWorkItemsHeaderControls";

describe("GitHubWorkItemsHeaderControls", () => {
  it("keeps the repository selector in the leading header controls", () => {
    const markup = renderToStaticMarkup(
      createElement(GitHubWorkItemsRepositorySelect, {
        repoOptions: [
          { key: "all", label: "All repositories" },
          { key: "org/repo", label: "org/repo" },
        ],
        selectedRepo: "all",
        onRepoSelect: vi.fn(),
      })
    );

    expect(markup).toContain('data-testid="github-work-items-repository"');
    expect(markup).toContain("All repositories");
  });

  it("keeps state, personal filters, search, and actions in the trailing header controls", () => {
    const markup = renderToStaticMarkup(
      createElement(GitHubWorkItemsHeaderControls, {
        stateTabs: [
          { key: "open", label: "Open" },
          { key: "closed", label: "Closed" },
        ],
        activeState: "open",
        searchQuery: "assignee:@me",
        personalFilterOptions: [{ value: "by_me", label: "Created by me" }],
        selectedPersonalFilters: ["by_me"],
        personalFilterLabel: "Filter",
        refreshLabel: "Refresh",
        refreshing: false,
        createAction: {
          label: "Create issue",
          disabled: false,
          onClick: vi.fn(),
        },
        onStateChange: vi.fn(),
        onSearchQueryChange: vi.fn(),
        onPersonalFiltersSelect: vi.fn(),
        onRefresh: vi.fn(),
      })
    );

    expect(markup).toContain('data-testid="github-work-items-header-controls"');
    expect(markup).not.toContain('data-testid="github-work-items-repository"');
    expect(markup).toContain('data-testid="github-work-items-state-open"');
    expect(markup).toContain('data-testid="github-work-items-search"');
    expect(markup).toContain('placeholder="Search..."');
    expect(markup).toContain('aria-label="Filter (1)"');
    expect(markup).toContain('data-icon="refresh-cw"');
    expect(markup).toContain('data-icon="square-pen"');
    expect(markup).toContain('class="flex shrink-0 items-center gap-px"');
    const refreshButton = markup.match(
      /<button[^>]*aria-label="Refresh"[^>]*>/
    )?.[0];
    expect(refreshButton).toContain("border-0");
    expect(refreshButton).toContain("bg-transparent");
    expect(refreshButton).not.toContain("border-border-2");
  });

  it("lets the same controls fill the compact left-pane header", () => {
    const markup = renderToStaticMarkup(
      createElement(GitHubWorkItemsHeaderControls, {
        stateTabs: [
          { key: "open", label: "Open" },
          { key: "closed", label: "Closed" },
        ],
        activeState: "open",
        searchQuery: "",
        refreshLabel: "Refresh",
        refreshing: false,
        placement: "list",
        onStateChange: vi.fn(),
        onSearchQueryChange: vi.fn(),
        onRefresh: vi.fn(),
      })
    );

    expect(markup).toContain("w-full min-w-0");
    expect(markup).not.toContain("w-64 max-w-[28vw]");
    expect(markup).toContain('data-icon="refresh-cw"');
  });
});
