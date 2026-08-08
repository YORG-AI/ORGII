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

    expect(idleMarkup).toContain("enabled:hover:!bg-surface-hover");
    expect(activeMarkup).toContain("!bg-surface-hover");
  });
});
