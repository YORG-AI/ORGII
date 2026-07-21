import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { GitHubWorkItemStateTabs } from "./GitHubWorkItemList";

describe("GitHubWorkItemStateTabs", () => {
  it("renders count-free Open and Closed controls for the published header", () => {
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
    expect(markup).not.toContain("<svg");
    expect(markup).toContain("rounded-lg border border-border-2 bg-bg-2 p-0.5");
    expect(markup).toContain('style="height:28px"');
  });
});
