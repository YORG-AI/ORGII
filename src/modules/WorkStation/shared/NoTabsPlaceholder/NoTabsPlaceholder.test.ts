import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NoTabsPlaceholder } from "./index";

describe("NoTabsPlaceholder", () => {
  it("renders contextual content below its shortcut actions", () => {
    const markup = renderToStaticMarkup(
      createElement(
        NoTabsPlaceholder,
        {
          icon: "browser",
          actions: [
            {
              id: "toggle-sidebar",
              label: "Hide Sidebar",
              shortcut: "Ctrl+Alt+U",
            },
          ],
        },
        createElement("button", { type: "button" }, "Open port 1998")
      )
    );

    expect(markup).toContain("Hide Sidebar");
    expect(markup).toContain("Open port 1998");
    expect(markup.indexOf("Open port 1998")).toBeGreaterThan(
      markup.indexOf("Hide Sidebar")
    );
  });
});
