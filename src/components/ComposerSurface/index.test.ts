import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ComposerSurface from ".";

describe("ComposerSurface", () => {
  it("uses the session composer action row for left and right actions", () => {
    const markup = renderToStaticMarkup(
      createElement(
        ComposerSurface,
        {
          leadingActions: createElement("button", null, "Review"),
          trailingActions: createElement("button", null, "Comment"),
          "data-testid": "markdown-composer",
        },
        createElement("div", null, "Markdown editor")
      )
    );

    expect(markup).toContain('data-testid="markdown-composer"');
    expect(markup).toContain("Markdown editor");
    expect(markup).toContain("Review");
    expect(markup).toContain("Comment");
    expect(markup).toContain("px-1.5 pt-2.5 pb-1.5 gap-2");
    expect(markup).toContain("h-9 min-h-9 w-full");
    expect(markup).toContain("justify-between px-1");
    expect(markup).not.toContain("composer-skills-tools-button");
  });

  it("omits an empty action row for editor-only composers", () => {
    const markup = renderToStaticMarkup(
      createElement(
        ComposerSurface,
        { "data-testid": "editor-only-composer" },
        createElement("div", null, "Markdown editor")
      )
    );

    expect(markup).toContain("Markdown editor");
    expect(markup).not.toContain("h-9 min-h-9 w-full");
  });
});
