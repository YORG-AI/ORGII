import { Provider, createStore } from "jotai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import RuntimeScanningPanel from "./RuntimeScanningPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@src/components/ModelIcon", () => ({
  default: () => createElement("span", { "data-testid": "model-icon" }),
}));

describe("RuntimeScanningPanel", () => {
  it("renders only the demand-loaded scanning inventory", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Provider,
        { store: createStore() },
        createElement(RuntimeScanningPanel)
      )
    );

    expect(markup).toContain("table-expanded-no-hover");
    expect(markup).toContain("table-settings-expanded-compact");
    expect(markup).toContain("tabs.all");
    expect(markup).toContain("tabs.apps");
    expect(markup).toContain("tabs.clis");
    expect(markup).not.toContain("data-source-view-usage");
    expect(markup).not.toContain("data-source-scroll-region");
  });
});
