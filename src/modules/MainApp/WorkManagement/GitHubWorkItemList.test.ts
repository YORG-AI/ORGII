import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  GitHubWorkItemStateTabs,
  GitHubWorkItemToolbarActions,
} from "./GitHubWorkItemList";

describe("GitHubWorkItemToolbarActions", () => {
  it("renders Refresh before the compact square-pencil action", () => {
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
    expect(markup).toContain('data-icon="square-pen"');
    expect(markup).not.toContain('data-icon="plus"');
    expect(markup).toContain('width="16"');
    expect(markup).toContain('height="16"');
    expect(markup.match(/border-0 bg-transparent text-text-2/g)).toHaveLength(
      2
    );
    expect(markup.match(/height:28px/g)).toHaveLength(2);
  });
});

describe("GitHubWorkItemStateTabs", () => {
  it("renders 32px text-and-icon Open and Closed buttons", () => {
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
    expect(markup).toContain('data-icon="circle-dot"');
    expect(markup).toContain('data-icon="check-circle-2"');
    expect(markup).toContain("text-success-6");
    expect(markup).toContain("text-purple-6");
    expect(markup).toContain(">Open</span>");
    expect(markup).toContain(">Closed</span>");
    expect(markup).not.toContain('class="sr-only">Open</span>');
    expect(markup).not.toContain('class="sr-only">Closed</span>');
    expect(markup).toContain("rounded-lg border border-border-2 bg-bg-2 p-0.5");
    expect(markup).toContain('style="height:32px"');
  });
});
