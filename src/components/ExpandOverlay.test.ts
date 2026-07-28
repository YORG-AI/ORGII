import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ExpandOverlay from "./ExpandOverlay";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("ExpandOverlay", () => {
  it("reveals a collapsed control only for its hovered or focused group", () => {
    const markup = renderToStaticMarkup(
      createElement(ExpandOverlay, {
        isExpanded: false,
        onToggle: vi.fn(),
        showLabel: true,
      })
    );

    expect(markup).toContain(
      "opacity-0 group-focus-within/expand:opacity-100 group-hover/expand:opacity-100"
    );
  });
});
