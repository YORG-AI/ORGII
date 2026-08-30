import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ReplayTabBar } from "./ReplayTabBar";

describe("ReplayTabBar", () => {
  it("uses text-1 for an active replay tab and its monochrome icon", () => {
    const markup = renderToStaticMarkup(
      createElement(ReplayTabBar, {
        tabs: [
          {
            eventId: "tool-1",
            kind: "tool",
            label: "Tool call",
            title: "Tool call",
          },
        ],
        activeEventId: "tool-1",
        onTabClick: vi.fn(),
      })
    );
    const activeSurface = markup.match(
      /<button[^>]*work-station-editor-tab--active[^>]*>/
    )?.[0];

    expect(activeSurface).toContain("text-text-1");
    expect(activeSurface).not.toContain("text-primary-6");
    expect(markup).toMatch(
      /<svg[^>]*class="[^"]*text-text-1[^"]*"[^>]*data-icon="wrench"/
    );
  });
});
