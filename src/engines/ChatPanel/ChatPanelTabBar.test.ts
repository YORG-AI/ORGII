import { Provider, createStore } from "jotai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { chatPanelTabsAtom } from "@src/store/chatPanel/chatPanelTabsAtom";

import { ChatPanelTabBar } from "./ChatPanelTabBar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("ChatPanelTabBar", () => {
  it("renders the close control inside the shared tab surface", () => {
    const store = createStore();
    store.set(chatPanelTabsAtom, {
      tabs: [
        {
          id: "launchpad-test",
          type: "start-page",
          title: "Launchpad",
        },
      ],
      activeTabId: "launchpad-test",
    });

    const markup = renderToStaticMarkup(
      createElement(Provider, { store }, createElement(ChatPanelTabBar))
    );

    expect(markup).toMatch(
      /<div[^>]*work-station-editor-tab[^>]*role="tab"[^>]*>.*<button type="button"/s
    );
    expect(markup.match(/<button type="button"/g)).toHaveLength(1);
  });
});
