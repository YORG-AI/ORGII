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
  it("waits for the inventory before mounting either the settings or table structure", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Provider,
        { store: createStore() },
        createElement(RuntimeScanningPanel)
      )
    );

    expect(markup).toContain('data-testid="runtime-scanning-title"');
    expect(markup).toContain("views.scanning");
    expect(markup).not.toContain("table-expanded-no-hover");
    expect(markup).not.toContain("table-settings-expanded-compact");
    expect(markup).not.toContain("tabs.all");
    expect(markup).not.toContain("tabs.apps");
    expect(markup).not.toContain("tabs.clis");
    expect(markup).not.toContain("data-source-view-usage");
    expect(markup).not.toContain("data-source-scroll-region");
  });
});
