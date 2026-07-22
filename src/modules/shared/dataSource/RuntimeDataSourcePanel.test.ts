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

vi.mock("@src/components/ModelIcon", () => ({
  default: () => createElement("span", { "data-testid": "model-icon" }),
}));

vi.mock("./SessionProvenanceHookPlatformsTable", () => ({
  default: () => createElement("div", null, "Hook platforms"),
}));

vi.mock("./SessionProvenanceRecentSignalsTable", () => ({
  default: () => createElement("div", null, "Recent signals"),
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

  it("can hide Runtime scroll chrome without disabling scrolling", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Provider,
        { store: createStore() },
        createElement(DataSourcePanel, {
          hideScrollbars: true,
          quotaContent: createElement("div", null, "Quota content"),
        })
      )
    );

    expect(markup).toContain(
      'data-testid="data-source-scroll-region" class="min-h-0 flex-1 overflow-y-auto px-4 scrollbar-hide @container"'
    );
    expect(markup).not.toContain("scrollbar-overlay");
  });

  it("hides redundant Scanning and Hooks headings only in Runtime", () => {
    const renderPanel = (
      activePanelView: "scanning" | "hooks",
      runtime: boolean
    ) =>
      renderToStaticMarkup(
        createElement(
          Provider,
          { store: createStore() },
          createElement(DataSourcePanel, {
            activePanelView,
            hideHeader: true,
            ...(runtime
              ? { quotaContent: createElement("div", null, "Quota content") }
              : {}),
          })
        )
      );

    expect(renderPanel("scanning", true)).not.toContain(
      'data-testid="data-source-section-title"'
    );
    expect(renderPanel("hooks", true)).not.toContain(
      'data-testid="session-provenance-hooks-title"'
    );
    expect(renderPanel("scanning", false)).toContain(
      'data-testid="data-source-section-title"'
    );
    expect(renderPanel("hooks", false)).toContain(
      'data-testid="session-provenance-hooks-title"'
    );
  });
});
