// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CREATOR_LAUNCHPAD_ACTIONS_VISIBLE_STORAGE_KEY,
  creatorLaunchpadActionsVisibleAtom,
} from "@src/store/session/creatorLaunchpadActionsVisibleAtom";
import {
  PINNED_ACTIONS_VISIBLE_STORAGE_KEY,
  pinnedActionsVisibleAtom,
} from "@src/store/session/pinnedActionsVisibleAtom";

import { NewChatHeaderActionsMenu } from "./NewChatHeaderActionsMenu";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/hooks/dropdown", () => ({
  getDropdownPanelStyle: () => ({}),
  useDropdownEngine: () => ({
    isOpen: true,
    isPositioned: true,
    toggle: vi.fn(),
    close: vi.fn(),
    triggerRef: { current: null },
    panelRef: { current: null },
    panelPosition: { left: 0, top: 0, width: 220 },
  }),
}));

vi.mock("@src/components/Dropdown/ActionMenuSurface", async () => {
  const React = await import("react");
  return {
    ActionMenuSurface: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children),
    ActionSubmenu: ({
      children,
      dataTestId,
    }: {
      children: React.ReactNode;
      dataTestId?: string;
    }) => React.createElement("div", { "data-testid": dataTestId }, children),
  };
});

describe("NewChatHeaderActionsMenu", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.removeItem(CREATOR_LAUNCHPAD_ACTIONS_VISIBLE_STORAGE_KEY);
    localStorage.removeItem(PINNED_ACTIONS_VISIBLE_STORAGE_KEY);
    store = createStore();
    store.set(creatorLaunchpadActionsVisibleAtom, true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(NewChatHeaderActionsMenu)
        )
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    vi.clearAllMocks();
  });

  it("toggles the persisted launchpad quick-action preference", () => {
    const toggle = document.querySelector<HTMLButtonElement>(
      '[data-testid="new-chat-show-quick-actions-toggle"]'
    );

    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-label")).toBe(
      "chat.startPage.showQuickActions"
    );
    expect(toggle?.getAttribute("aria-checked")).toBe("true");

    act(() => toggle?.click());

    expect(store.get(creatorLaunchpadActionsVisibleAtom)).toBe(false);
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
  });

  it("shows the skills toggle off by default and can enable pinned skills", () => {
    const toggle = document.querySelector<HTMLButtonElement>(
      '[data-testid="new-chat-show-skills-toggle"]'
    );

    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-label")).toBe(
      "chat.startPage.showSkills"
    );
    expect(toggle?.getAttribute("aria-checked")).toBe("false");

    act(() => toggle?.click());

    expect(store.get(pinnedActionsVisibleAtom)).toBe(true);
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
  });
});
