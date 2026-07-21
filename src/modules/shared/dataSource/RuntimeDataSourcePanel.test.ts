import { Provider, createStore } from "jotai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import DataSourcePanel from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
}));

vi.mock("./SessionUsagePanel", () => ({
  default: () => createElement("div", null, "Usage dashboard"),
}));

describe("Runtime DataSourcePanel navigation", () => {
  it("keeps its five sections ordered below the chat header", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Provider,
        { store: createStore() },
        createElement(DataSourcePanel, {
          assetsContent: createElement("div", null, "Assets content"),
          quotaContent: createElement("div", null, "Quota content"),
        })
      )
    );

    const usage = markup.indexOf("data-source-view-usage");
    const quota = markup.indexOf("data-source-view-quota");
    const scanning = markup.indexOf("data-source-view-scanning");
    const hooks = markup.indexOf("data-source-view-hooks");
    const assets = markup.indexOf("data-source-view-assets");

    expect(usage).toBeGreaterThanOrEqual(0);
    expect(quota).toBeGreaterThan(usage);
    expect(scanning).toBeGreaterThan(quota);
    expect(hooks).toBeGreaterThan(scanning);
    expect(assets).toBeGreaterThan(hooks);
    expect(markup).toContain("Usage dashboard");
    expect(markup).not.toContain("Quota content");
    expect(markup).toContain("max-w-[932px]");
    expect(markup).toContain("max-w-[900px]");
    expect(markup).toContain("flex flex-col gap-3");
    expect(markup).not.toContain("chat-panel-header");
    expect(markup).toContain('data-testid="data-source-scroll-region"');
    expect(markup).toContain("overflow-y-auto");
  });

  it("supports a shell-published header with controlled panel navigation", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Provider,
        { store: createStore() },
        createElement(DataSourcePanel, {
          activePanelView: "quota",
          onPanelViewChange: vi.fn(),
          hideHeader: true,
          quotaContent: createElement("div", null, "Quota content"),
        })
      )
    );

    expect(markup).toContain("Quota content");
    expect(markup).not.toContain("data-source-view-usage");
    expect(markup).not.toContain("data-source-view-quota");
  });
});
