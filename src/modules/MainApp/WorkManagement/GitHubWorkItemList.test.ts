import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  GitHubWorkItemStateTabs,
  GitHubWorkItemToolbarActions,
} from "./GitHubWorkItemList";

vi.mock("@src/components/KeyboardShortcut/ToolbarTooltip", () => ({
  ToolbarTooltip: ({
    children,
    label,
  }: {
    children: ReactNode;
    label: string;
  }) => createElement("span", { "data-tooltip-label": label }, children),
}));

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
    expect(markup).toContain('data-tooltip-label="Refresh"');
    expect(markup).toContain('data-tooltip-label="Create issue"');
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
  it("renders a compact, icon-only pill switch for Open and Closed", () => {
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
    expect(markup).not.toContain(">Open</span>");
    expect(markup).not.toContain(">Closed</span>");
    expect(markup).toContain('aria-label="Open"');
    expect(markup).toContain('aria-label="Closed"');
    expect(markup).toContain('title="Open"');
    expect(markup).toContain('title="Closed"');
    expect(markup).toContain("rounded-[100px]");
    expect(markup).toContain("bg-fill-1");
    expect(markup).not.toContain("mt-1 h-1 w-1 rounded-full");
    expect(markup).not.toContain("rounded-lg border border-border-2 bg-bg-2");
    expect(markup).toContain('style="height:28px"');
  });
});
