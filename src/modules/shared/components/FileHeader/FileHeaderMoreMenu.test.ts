// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activeOverlayCountAtom } from "@src/store/ui/overlayLayerAtom";

import {
  FileHeaderMoreMenu,
  type FileHeaderMoreMenuProps,
} from "./FileHeaderMoreMenu";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@src/util/ui/theme/themeUtils", () => ({
  useCurrentTheme: () => ({ isDark: false }),
}));

let container: HTMLDivElement;
let root: Root;
let store: ReturnType<typeof createStore>;
let props: FileHeaderMoreMenuProps;

function render(overrides: Partial<FileHeaderMoreMenuProps> = {}) {
  props = { ...props, ...overrides };
  act(() =>
    root.render(
      createElement(
        Provider,
        { store },
        createElement(FileHeaderMoreMenu, props)
      )
    )
  );
  act(() => vi.advanceTimersByTime(32));
}

function element(testId: string): HTMLElement {
  const result = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`
  );
  expect(result, testId).not.toBeNull();
  return result!;
}

function openSettings() {
  act(() => element("file-header-ui-settings-submenu").click());
  return element("file-header-ui-settings-submenu-panel");
}

function key(value: string) {
  act(() =>
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
        cancelable: true,
      })
    )
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = createStore();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  props = {
    showReloadButton: true,
    showSearchAction: true,
    showGoToLineAction: true,
    showSaveAction: true,
    showDiscardAction: true,
    showCopyRelativePathAction: true,
    showRevealInFileManagerAction: true,
    showLineNumbersToggle: true,
    showWordWrapToggle: true,
    showMinimapToggle: true,
    showHighlightActiveLineToggle: true,
    showGitBlameToggle: false,
    showMoreSettingsAction: true,
    lineNumbersEnabled: true,
    wordWrapEnabled: false,
    minimapEnabled: false,
    highlightActiveLineEnabled: true,
    gitBlameEnabled: false,
    loading: false,
    hasUnsavedChanges: true,
    reloadSpinClass: undefined,
    reloadMenuCoolingDown: false,
    menuVisible: true,
    setMenuVisible: vi.fn((menuVisible: boolean) => render({ menuVisible })),
    onSaveClick: vi.fn(),
    onDiscardClick: vi.fn(),
    onSearchClick: vi.fn(),
    onGoToLineClick: vi.fn(),
    onCopyRelativePathClick: vi.fn(),
    onRevealInFileManagerClick: vi.fn(),
    onReloadClick: vi.fn(),
    onLineNumbersChange: vi.fn((lineNumbersEnabled: boolean) =>
      render({ lineNumbersEnabled })
    ),
    onWordWrapChange: vi.fn(),
    onMinimapChange: vi.fn(),
    onHighlightActiveLineChange: vi.fn(),
    onGitBlameChange: vi.fn(),
    onMoreSettingsClick: vi.fn(() => render({ menuVisible: false })),
  };
});

afterEach(() => {
  act(() => root.unmount());
  expect(store.get(activeOverlayCountAtom)).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("FileHeaderMoreMenu", () => {
  it("keeps file actions at the first level and moves display controls into UI settings", () => {
    render();
    const menu = element("file-header-more-menu");
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(8);
    expect(menu.querySelector('[role="switch"]')).toBeNull();
    expect(menu.textContent).not.toContain("common:actions.moreSettings");

    const panel = openSettings();
    const switches =
      panel.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    expect(
      [...switches].map((control) => control.getAttribute("aria-label"))
    ).toEqual([
      "settings:editor.lineNumbers",
      "settings:editor.wordWrap",
      "settings:editor.minimap",
      "settings:editor.highlightActiveLine",
      "Git Blame",
    ]);
    expect(switches[0].getAttribute("aria-checked")).toBe("true");
    act(() => switches[0].click());
    expect(props.onLineNumbersChange).toHaveBeenCalledOnce();
    expect(props.onLineNumbersChange).toHaveBeenCalledWith(false);
    expect(switches[0].getAttribute("aria-checked")).toBe("false");
    act(() =>
      switches[1].closest<HTMLElement>('[role="menuitemcheckbox"]')!.click()
    );
    expect(props.onWordWrapChange).toHaveBeenCalledOnce();
    expect(props.onWordWrapChange).toHaveBeenCalledWith(true);
    expect(switches[4].disabled).toBe(true);
    act(() =>
      switches[4].closest<HTMLElement>('[role="menuitemcheckbox"]')!.click()
    );
    expect(props.onGitBlameChange).not.toHaveBeenCalled();
    expect(props.setMenuVisible).not.toHaveBeenCalled();
    expect(element("file-header-ui-settings-submenu-panel")).toBe(panel);

    act(() => panel.querySelector<HTMLElement>('[role="menuitem"]')!.click());
    expect(props.onMoreSettingsClick).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("opens by keyboard, navigates switches, and closes one layer at a time", () => {
    render();
    key("End");
    const trigger = element("file-header-ui-settings-submenu");
    expect(document.activeElement).toBe(trigger);
    key("Enter");
    const panel = element("file-header-ui-settings-submenu-panel");
    key("ArrowDown");
    expect(document.activeElement).toBe(panel.querySelector('[role="switch"]'));
    key("End");
    expect(document.activeElement?.textContent).toBe(
      "common:actions.moreSettings"
    );
    key("Escape");
    expect(document.querySelector('[role="switch"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(props.setMenuVisible).not.toHaveBeenCalled();
    key("ArrowLeft");
    element("file-header-ui-settings-submenu-panel");
    key("ArrowRight");
    expect(document.activeElement).toBe(trigger);
    key("Escape");
    expect(props.setMenuVisible).toHaveBeenCalledOnce();
    expect(props.setMenuVisible).toHaveBeenCalledWith(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("preserves disabled actions while loading without disabling display settings", () => {
    render({ loading: true, showSearchAction: false });
    const menu = element("file-header-more-menu");
    for (const label of [
      "common:actions.save",
      "common:workstation.discardChanges",
      "actions.search",
      "common:actions.refresh",
    ]) {
      const row = [
        ...menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ].find((item) => item.textContent?.includes(label))!;
      expect(row.getAttribute("aria-disabled")).toBe("true");
      act(() => row.click());
    }
    expect(props.onSaveClick).not.toHaveBeenCalled();
    expect(props.onDiscardClick).not.toHaveBeenCalled();
    expect(props.onSearchClick).not.toHaveBeenCalled();
    expect(props.onReloadClick).not.toHaveBeenCalled();
    openSettings();
    expect(
      document.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled
    ).toBe(false);
  });

  it("drops submenu state, timers, and keyboard listeners across repeated closes", () => {
    const added = vi.spyOn(document, "addEventListener");
    const removed = vi.spyOn(document, "removeEventListener");
    const visibility = vi.spyOn(document, "visibilityState", "get");
    render({ menuVisible: false });
    for (let cycle = 0; cycle < 3; cycle += 1) {
      act(() => container.querySelector<HTMLButtonElement>("button")!.click());
      act(() => vi.advanceTimersByTime(32));
      expect(document.querySelector('[role="switch"]')).toBeNull();
      openSettings();
      expect(store.get(activeOverlayCountAtom)).toBe(1);
      for (const state of ["visible", "hidden"] as const) {
        visibility.mockReturnValue(state);
        act(() => {
          document.dispatchEvent(new Event("visibilitychange"));
          vi.advanceTimersByTime(60_000);
        });
        expect(vi.getTimerCount()).toBe(0);
      }
      act(() =>
        document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }))
      );
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(store.get(activeOverlayCountAtom)).toBe(0);
      // The engine resets its positioned flag on the next frame after close.
      act(() => vi.advanceTimersByTime(32));
      expect(vi.getTimerCount()).toBe(0);
    }
    const keyboardAdds = added.mock.calls.filter(
      ([type]) => type === "keydown"
    );
    const keyboardRemoves = removed.mock.calls.filter(
      ([type]) => type === "keydown"
    );
    expect(keyboardAdds.length).toBeGreaterThan(0);
    expect(keyboardRemoves).toEqual(keyboardAdds);
  });
});
