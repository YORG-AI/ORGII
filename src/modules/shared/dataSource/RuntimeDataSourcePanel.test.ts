import { Provider, createStore } from "jotai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import RuntimeDataSourcePanel from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
}));

vi.mock("./SessionUsagePanel", () => ({
  default: () => createElement("div", null, "Usage dashboard"),
}));

vi.mock("@src/components/ModelIcon", () => ({
  default: () => createElement("span", { "data-testid": "model-icon" }),
}));

vi.mock("./SessionProvenanceHookPlatformsTable", () => ({
  default: () => createElement("div", null, "Hook platforms"),
}));

vi.mock("./SessionProvenanceRecentSignalsTable", () => ({
  default: () => createElement("div", null, "Recent signals"),
}));

describe("RuntimeDataSourcePanel navigation", () => {
  it("keeps its five sections ordered below the chat header", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Provider,
        { store: createStore() },
        createElement(RuntimeDataSourcePanel, {
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

  it("hides Runtime scroll chrome without disabling scrolling", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Provider,
        { store: createStore() },
        createElement(RuntimeDataSourcePanel, {
          assetsContent: createElement("div", null, "Assets content"),
          quotaContent: createElement("div", null, "Quota content"),
        })
      )
    );

    expect(markup).toContain(
      'data-testid="data-source-scroll-region" class="min-h-0 flex-1 overflow-y-auto px-4 scrollbar-hide @container"'
    );
    expect(markup).not.toContain("scrollbar-overlay");
  });
});
