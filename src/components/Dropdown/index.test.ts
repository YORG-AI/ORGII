// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { activeOverlayCountAtom } from "@src/store/ui/overlayLayerAtom";

import Dropdown from ".";

describe("Dropdown", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("right-aligns the menu by default", () => {
    const props: React.ComponentProps<typeof Dropdown> = {
      defaultPopupVisible: true,
      droplist: React.createElement("div", null, "Menu"),
      children: React.createElement("button", { type: "button" }, "Open"),
    };
    const markup = renderToStaticMarkup(React.createElement(Dropdown, props));

    expect(markup).toContain("top-full right-0 mt-2");
    expect(markup).not.toContain("top-full left-0 mt-2");
  });

  it("registers a visible controlled menu as a webview-blocking overlay", async () => {
    const store = createStore();
    const renderDropdown = (popupVisible: boolean) => {
      const props: React.ComponentProps<typeof Dropdown> = {
        popupVisible,
        droplist: React.createElement("div", null, "Menu"),
        children: React.createElement("button", { type: "button" }, "Open"),
      };

      return React.createElement(
        Provider,
        { store },
        React.createElement(Dropdown, props)
      );
    };
    const renderVisibleState = async (popupVisible: boolean) => {
      await act(async () => {
        root.render(renderDropdown(popupVisible));
        await Promise.resolve();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        );
      });
    };

    await renderVisibleState(false);
    expect(store.get(activeOverlayCountAtom)).toBe(0);

    await renderVisibleState(true);
    expect(store.get(activeOverlayCountAtom)).toBe(1);

    await renderVisibleState(false);
    expect(store.get(activeOverlayCountAtom)).toBe(0);
  });

  it("keeps options-mode keyboard navigation working from a portaled search input", async () => {
    const props: React.ComponentProps<typeof Dropdown> = {
      defaultPopupVisible: true,
      showSearch: true,
      options: [
        {
          label: "One",
          value: "one",
          dataTestId: "dropdown-option-one",
        },
        {
          label: "Two",
          value: "two",
          dataTestId: "dropdown-option-two",
        },
      ],
      getPopupContainer: () => document.body,
      children: React.createElement("button", { type: "button" }, "Open"),
    };
    await act(async () => {
      root.render(React.createElement(Dropdown, props));
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });

    const searchInput =
      document.body.querySelector<HTMLInputElement>('input[type="text"]');
    expect(searchInput).not.toBeNull();
    act(() => searchInput?.focus());
    expect(document.activeElement).toBe(searchInput);

    act(() => {
      searchInput?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      );
    });

    const secondOption = document.body.querySelector<HTMLElement>(
      '[data-testid="dropdown-option-two"]'
    );
    expect(secondOption?.classList.contains("bg-fill-2")).toBe(true);
  });
});
