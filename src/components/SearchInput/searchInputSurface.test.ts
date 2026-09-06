import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SearchInput } from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("SearchInput surfaces", () => {
  it("supports an outline-only transparent surface", () => {
    const markup = renderToStaticMarkup(
      createElement(SearchInput, {
        value: "is:pr is:open",
        onChange: vi.fn(),
        surface: "transparent",
      })
    );

    expect(markup).toContain("bg-transparent!");
    expect(markup).toContain("border-border-2");
  });

  it("supports a layout-stable ghost surface that restores the normal field on focus", () => {
    const markup = renderToStaticMarkup(
      createElement(SearchInput, {
        value: "is:pr is:open",
        onChange: vi.fn(),
        surface: "ghost",
      })
    );

    expect(markup).toContain("border-transparent!");
    expect(markup).toContain("bg-transparent!");
    expect(markup).not.toContain("border-0!");
    expect(markup).toContain("hover]:bg-fill-2!");
    expect(markup).toContain("focus-within:border-primary-6!");
    expect(markup).toContain("focus-within:bg-pane-input!");
  });
});
