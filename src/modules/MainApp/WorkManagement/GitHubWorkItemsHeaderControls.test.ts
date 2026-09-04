import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  GitHubWorkItemsFilterControls,
  GitHubWorkItemsRepositorySelect,
  GitHubWorkItemsSearchAndActions,
} from "./GitHubWorkItemsHeaderControls";

describe("GitHubWorkItemsHeaderControls", () => {
  it("keeps the repository selector in the leading header controls", () => {
    const markup = renderToStaticMarkup(
      createElement(GitHubWorkItemsRepositorySelect, {
        repoOptions: [{ key: "org/repo", label: "org/repo" }],
        selectedRepo: "org/repo",
        onRepoSelect: vi.fn(),
      })
    );

    expect(markup).toContain('data-testid="github-work-items-repository"');
    expect(markup).toContain(">repo<");
    expect(markup).not.toContain(">org/repo<");
    expect(markup).not.toContain("All repositories");
  });

  it("groups the state and personal filters together", () => {
    const markup = renderToStaticMarkup(
      createElement(GitHubWorkItemsFilterControls, {
        stateTabs: [{ key: "open", label: "Open" }],
        activeState: "open",
        personalFilterOptions: [{ value: "by_me", label: "Created by me" }],
        selectedPersonalFilters: ["by_me"],
        personalFilterLabel: "Filter",
        onStateChange: vi.fn(),
        onPersonalFiltersSelect: vi.fn(),
      })
    );

    expect(markup).toContain('data-testid="github-work-items-state-open"');
    expect(markup).toContain('aria-label="Filter (1)"');
    expect(markup).toContain('class="flex shrink-0 items-center gap-px"');
  });

  it("keeps the search and actions together on the right", () => {
    const markup = renderToStaticMarkup(
      createElement(GitHubWorkItemsSearchAndActions, {
        searchQuery: "",
        refreshLabel: "Refresh",
        refreshing: false,
        fillSearch: true,
        onSearchQueryChange: vi.fn(),
        onRefresh: vi.fn(),
      })
    );

    expect(markup).toContain("gap-1");
    expect(markup).toContain('class="flex min-w-0 items-center gap-1 flex-1"');
    expect(markup).toContain("w-full min-w-0");
    expect(markup).toContain("border-0!");
    expect(markup).toContain("focus-within:border-primary-6!");
    expect(markup).toContain("focus-within:bg-pane-input!");
    expect(markup).toContain('data-icon="refresh-cw"');
  });
});
