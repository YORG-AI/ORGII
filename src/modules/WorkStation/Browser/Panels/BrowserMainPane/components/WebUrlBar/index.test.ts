// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import WebUrlBar from ".";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/components/KeyboardShortcut/ToolbarTooltip", () => ({
  ToolbarTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

describe("WebUrlBar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("disables webview-dependent controls for a blank tab", () => {
    act(() => {
      root.render(
        createElement(
          Provider,
          { store: createStore() },
          createElement(WebUrlBar, {
            url: "",
            onNavigate: vi.fn(),
            onReload: vi.fn(),
            onToggleInspectMode: vi.fn(),
            onOpenNativeDevTools: vi.fn(),
            hasActiveWebview: false,
            inline: true,
          })
        )
      );
    });

    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="common:actions.reload"]'
      )?.disabled
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="tooltips.enableInspectMode"]'
      )?.disabled
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="tooltips.openNativeDevTools"]'
      )?.disabled
    ).toBe(true);
  });
});
