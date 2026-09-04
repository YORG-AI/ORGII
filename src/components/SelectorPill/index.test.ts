import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import SelectorPill from ".";

describe("SelectorPill", () => {
  it("uses the shared hover and active pill surfaces", () => {
    const idleMarkup = renderToStaticMarkup(
      createElement(SelectorPill, {
        icon: null,
        label: "Skills",
        onClick: vi.fn(),
      })
    );
    const activeMarkup = renderToStaticMarkup(
      createElement(SelectorPill, {
        active: true,
        icon: null,
        label: "Skills",
        onClick: vi.fn(),
      })
    );

    expect(idleMarkup).toContain("enabled:hover:bg-surface-hover!");
    expect(activeMarkup).toContain("bg-surface-hover!");
  });

  it("supports a neutral active text treatment", () => {
    const markup = renderToStaticMarkup(
      createElement(SelectorPill, {
        active: true,
        activeTone: "neutral",
        icon: null,
        label: "SDE Agent",
        onClick: vi.fn(),
      })
    );

    expect(markup).toContain("text-text-1");
    expect(markup).not.toContain("text-primary-6");
  });
});
