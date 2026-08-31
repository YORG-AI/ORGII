// @vitest-environment jsdom
import { createInstance } from "i18next";
import { Provider, createStore } from "jotai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import enSessions from "@src/i18n/locales/en/sessions.json";
import { workStationEditorSecondaryCollapsedAtom } from "@src/store/ui/workStationAtom";
import {
  activeStatusBarAppAtom,
  perAppStatusBarCallbacksAtom,
} from "@src/store/ui/workStationLayout/statusBarAtoms";

import { TabBarBottomPanelToggle } from "./TabBarTrailingControls";

vi.mock("@src/components/Tooltip", () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

describe("TabBarBottomPanelToggle", () => {
  const i18n = createInstance();

  beforeAll(async () => {
    await i18n.use(initReactI18next).init({
      lng: "en",
      fallbackLng: false,
      defaultNS: "sessions",
      ns: ["sessions"],
      resources: { en: { sessions: enSessions } },
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
  });

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
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          Provider,
          { store },
          createElement(TabBarBottomPanelToggle)
        )
      )
    );

    expect(markup).toContain('title="Show bottom panel"');
    expect(markup).toContain('aria-label="Show bottom panel"');
    expect(markup).not.toContain("titleBar.showBottomPanel");
  });
});
