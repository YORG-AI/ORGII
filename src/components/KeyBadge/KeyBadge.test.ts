import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import KeyBadge from "./index";

describe("KeyBadge", () => {
  it("does not render an empty pill for an unassigned shortcut", () => {
    const markup = renderToStaticMarkup(createElement(KeyBadge, { keys: "" }));

    expect(markup).toBe("");
  });

  it("renders a shortcut chord as one rounded pill", () => {
    const markup = renderToStaticMarkup(
      createElement(KeyBadge, { keys: "⌘2", showSeparator: false })
    );

    expect(markup.match(/<kbd/g)).toHaveLength(1);
    expect(markup).toContain("rounded-full");
    expect(markup).toContain("bg-fill-2");
    expect(markup).toContain('data-icon="command"');
    expect(markup).toContain(">2</span>");
  });

  it("keeps alternative shortcut chords in separate pills", () => {
    const markup = renderToStaticMarkup(
      createElement(KeyBadge, {
        keys: "Ctrl+Tab / ⌘⌥→",
        showSeparator: false,
      })
    );

    expect(markup.match(/<kbd/g)).toHaveLength(2);
    expect(markup).toContain("/");
  });
});
