import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import DropdownSearch from "./DropdownSearch";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => (key === "actions.search" ? "Localized Search" : key),
  }),
}));

describe("DropdownSearch", () => {
  it("uses the concise localized search label by default", () => {
    const markup = renderToStaticMarkup(
      createElement(DropdownSearch, {
        value: "",
        onChange: vi.fn(),
      })
    );

    expect(markup).toContain('placeholder="Localized Search"');
    expect(markup).toContain('aria-label="Localized Search"');
  });
});
