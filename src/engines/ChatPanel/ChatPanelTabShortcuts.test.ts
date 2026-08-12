// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { type RefObject, act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { chatPanelTabsAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import { isMacOS } from "@src/util/platform/tauri";

import { resolveChatPanelShortcutOwnership } from "./hooks/chatPanelShortcutOwnership";
import {
  isChatPanelPrimaryModifierPressed,
  useChatPanelTabShortcuts,
} from "./hooks/useChatPanelTabShortcuts";

interface ShortcutHarnessProps {
  panelRef: RefObject<HTMLElement | null>;
}

function ShortcutHarness({ panelRef }: ShortcutHarnessProps) {
  useChatPanelTabShortcuts({
    onNewSession: vi.fn(),
    onNewTerminal: vi.fn(),
    containerRef: panelRef,
  });
  return null;
}

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("useChatPanelTabShortcuts", () => {
  let container: HTMLDivElement;
  let neutralOverlay: HTMLDivElement;
  let outsideButton: HTMLButtonElement;
  let panelElement: HTMLElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;
  let panelRef: RefObject<HTMLElement | null>;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(async () => {
    store = createStore();
    container = document.createElement("div");
    container.dataset.workbenchSurface = "";
    neutralOverlay = document.createElement("div");
    neutralOverlay.dataset.testid = "portaled-overlay";
    panelElement = document.createElement("section");
    panelElement.dataset.testid = "chat-panel";
    panelElement.append(
      Object.assign(document.createElement("button"), {
        textContent: "Chat action",
        type: "button",
      })
    );
    panelRef = { current: panelElement };
    outsideButton = document.createElement("button");
    outsideButton.dataset.workbenchSurface = "";
    outsideButton.textContent = "WorkStation action";
    document.body.append(
      container,
      neutralOverlay,
      panelElement,
      outsideButton
    );
    root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(ShortcutHarness, { panelRef })
        )
      );
    });
    await act(async () => {
      store.set(chatPanelTabsAtom, {
        tabs: [
          { id: "launchpad", type: "start-page", title: "Launchpad" },
          { id: "runtime", type: "runtime", title: "Runtime" },
        ],
        activeTabId: "runtime",
      });
      store.set(chatPanelMaximizedAtom, false);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    neutralOverlay.remove();
    panelElement.remove();
    outsideButton.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function pressCloseShortcut(target: HTMLElement): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
      key: "w",
      code: "KeyW",
      metaKey: isMacOS(),
      ctrlKey: !isMacOS(),
      bubbles: true,
      cancelable: true,
    });
    act(() => target.dispatchEvent(event));
    return event;
  }

  function interactWith(target: HTMLElement): void {
    act(() =>
      target.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true })
      )
    );
  }

  it("closes the active chat tab after interacting with a non-focusable part of the pane", () => {
    const workstationShortcut = vi.fn();
    document.addEventListener("keydown", workstationShortcut, true);
    outsideButton.focus();
    interactWith(panelElement);

    const event = pressCloseShortcut(outsideButton);
    document.removeEventListener("keydown", workstationShortcut, true);

    expect(event.defaultPrevented).toBe(true);
    expect(workstationShortcut).not.toHaveBeenCalled();
    expect(store.get(chatPanelTabsAtom).tabs.map((tab) => tab.id)).toEqual([
      "launchpad",
    ]);
  });

  it("closes the active chat tab while maximized even when focus remained in the WorkStation", async () => {
    await act(async () => store.set(chatPanelMaximizedAtom, true));
    outsideButton.focus();

    const event = pressCloseShortcut(outsideButton);

    expect(event.defaultPrevented).toBe(true);
    expect(store.get(chatPanelTabsAtom).tabs.map((tab) => tab.id)).toEqual([
      "launchpad",
    ]);
  });

  it("leaves the shortcut for the WorkStation when the chat pane is neither focused nor maximized", () => {
    outsideButton.focus();

    const event = pressCloseShortcut(outsideButton);

    expect(event.defaultPrevented).toBe(false);
    expect(store.get(chatPanelTabsAtom).tabs).toHaveLength(2);
  });

  it("returns shortcut ownership to the WorkStation after an outside pane interaction", () => {
    const chatButton = panelRef.current?.querySelector("button");
    if (!(chatButton instanceof HTMLButtonElement)) {
      throw new Error("Chat shortcut test button did not render");
    }
    chatButton.focus();
    interactWith(container);

    const event = pressCloseShortcut(chatButton);

    expect(document.activeElement).toBe(chatButton);
    expect(event.defaultPrevented).toBe(false);
    expect(store.get(chatPanelTabsAtom).tabs).toHaveLength(2);
  });

  it("preserves pane ownership through a portaled overlay interaction", () => {
    const chatButton = panelRef.current?.querySelector("button");
    if (!(chatButton instanceof HTMLButtonElement)) {
      throw new Error("Chat shortcut test button did not render");
    }
    chatButton.focus();
    interactWith(neutralOverlay);

    const event = pressCloseShortcut(chatButton);

    expect(event.defaultPrevented).toBe(true);
    expect(store.get(chatPanelTabsAtom).tabs).toHaveLength(1);
  });

  it("preserves active chat ownership when the shortcut target is neutral", () => {
    expect(
      resolveChatPanelShortcutOwnership(panelElement, document.body, true)
    ).toBe(true);
    expect(
      resolveChatPanelShortcutOwnership(panelElement, neutralOverlay, true)
    ).toBe(true);
    expect(
      resolveChatPanelShortcutOwnership(panelElement, outsideButton, true)
    ).toBe(false);
  });

  it("uses Command on macOS and Ctrl on other platforms", () => {
    expect(
      isChatPanelPrimaryModifierPressed({ metaKey: true, ctrlKey: false }, true)
    ).toBe(true);
    expect(
      isChatPanelPrimaryModifierPressed(
        { metaKey: false, ctrlKey: true },
        false
      )
    ).toBe(true);
    expect(
      isChatPanelPrimaryModifierPressed(
        { metaKey: true, ctrlKey: false },
        false
      )
    ).toBe(false);
  });
});
