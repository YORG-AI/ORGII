import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SpotlightFormBody, SpotlightFormShell } from "./SpotlightFormShell";

describe("SpotlightFormShell", () => {
  it("leaves the outer border and radius to the Spotlight shell", () => {
    const markup = renderToStaticMarkup(
      createElement(
        SpotlightFormShell,
        null,
        createElement(SpotlightFormBody, null, "Form content")
      )
    );

    expect(markup).toContain('class="overflow-hidden bg-chat-input"');
    expect(markup).toContain('class="p-3"');
    expect(markup).not.toContain("border");
    expect(markup).not.toContain("rounded");
  });
});
