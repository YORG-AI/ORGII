// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { workStationEditorSecondaryCollapsedAtom } from "@src/store/ui/workStationAtom";
import {
  activeStatusBarAppAtom,
  perAppStatusBarCallbacksAtom,
} from "@src/store/ui/workStationLayout/statusBarAtoms";

import { TabBarBottomPanelToggle } from "./TabBarTrailingControls";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => `localized:${key}`,
  }),
}));

vi.mock("@src/components/Tooltip", () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

describe("TabBarBottomPanelToggle", () => {
  it("uses the localized bottom-panel label", () => {
    const store = createStore();
    store.set(activeStatusBarAppAtom, "code");
    store.set(workStationEditorSecondaryCollapsedAtom, true);
    store.set(perAppStatusBarCallbacksAtom, {
      code: { onToggleBottomPanel: vi.fn() },
      data: {},
      browser: {},
      project: {},
    });

    const markup = renderToStaticMarkup(
      createElement(Provider, { store }, createElement(TabBarBottomPanelToggle))
    );

    expect(markup).toContain('title="localized:titleBar.showBottomPanel"');
    expect(markup).toContain('aria-label="localized:titleBar.showBottomPanel"');
    expect(markup).not.toContain("Show bottom panel");
  });
});
