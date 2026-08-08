import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import Checkbox from ".";

vi.mock("@src/util/ui/theme/themeUtils", () => ({
  useCurrentTheme: () => ({ theme: "light", isDark: false }),
}));

describe("Checkbox", () => {
  it("does not transition inherited visibility from hover-only parents", () => {
    const markup = renderToStaticMarkup(
      createElement(Checkbox, {
        checked: false,
        onChange: vi.fn(),
        ariaLabel: "Select row",
      })
    );

    expect(markup).not.toContain("transition-all");
    expect(markup).toContain(
      "transition-[background-color,border-color,box-shadow]"
    );
    expect(markup).toContain("transition-[opacity,transform]");
  });
});
