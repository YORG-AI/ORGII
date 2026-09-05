import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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
        tabs: [{ id: "tab-a", title: "Tab A" }],
        label: "Recent",
        onOpen: vi.fn(),
      })
    );

    expect(markup).toContain('data-recent-tab-id="tab-a"');
    expect(markup).toContain('role="menuitem"');
    expect(markup).toContain("Tab A");
    expect(markup).toContain('data-icon="work-history"');
  });

  it("uses a supplied session identity icon instead of the history icon", () => {
    const markup = renderToStaticMarkup(
      createElement(RecentTabsMenuSection, {
        tabs: [
          {
            id: "session-a",
            title: "Codex session",
            leadingIcon: createElement("span", {
              "data-session-icon": "codex",
            }),
          },
        ],
        label: "Recent",
        onOpen: vi.fn(),
      })
    );

    expect(markup).toContain('data-session-icon="codex"');
    expect(markup).not.toContain('data-icon="work-history"');
  });
});
