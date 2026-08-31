// @vitest-environment jsdom
import { type ComponentProps, act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { popupNativeMenu } from "@src/util/platform/tauri/nativeMenuPopup";

import RepoChromeRow from "./RepoChromeRow";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key.endsWith(".moveToTop")) return "Move to top";
      if (key.endsWith(".moveToBottom")) return "Move to bottom";
      if (key.endsWith(".showPinnedActions")) return "Show pinned actions";
      return "Hide pinned actions";
    },
  }),
}));

vi.mock("@src/util/platform/tauri/nativeMenuPopup", () => ({
  popupNativeMenu: vi.fn().mockResolvedValue({ status: "closed" }),
}));

const mockedPopupNativeMenu = vi.mocked(popupNativeMenu);
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("RepoChromeRow", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockedPopupNativeMenu.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("offers direct move and pinned-action visibility commands", async () => {
    const onPositionChange = vi.fn();
    const onPinnedActionsVisibleChange = vi.fn();
    act(() => {
      root.render(
        createElement(
          RepoChromeRow,
          {
            pinnedActionsVisible: true,
            position: "top",
            onPinnedActionsVisibleChange,
            onPositionChange,
          } as unknown as ComponentProps<typeof RepoChromeRow>,
          createElement("span", null, "repository chrome")
        )
      );
    });

    const row = container.querySelector<HTMLElement>(
      '[data-testid="session-creator-repo-chrome"]'
    );
    expect(row).not.toBeNull();

    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    act(() => row?.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(mockedPopupNativeMenu).toHaveBeenCalledOnce();
    const popupOptions = mockedPopupNativeMenu.mock.calls[0]?.[0];
    expect(popupOptions?.source).toBe("session-creator-repo-chrome");

    const items = await popupOptions?.buildItems();
    const moveItem = items?.[0] as
      | { text?: string; action?: () => void }
      | undefined;
    const pinnedActionsItem = items?.[2] as
      | { text?: string; action?: () => void }
      | undefined;
    expect(moveItem?.text).toBe("Move to bottom");
    expect(pinnedActionsItem?.text).toBe("Hide pinned actions");

    act(() => moveItem?.action?.());
    expect(onPositionChange).toHaveBeenCalledWith("bottom");

    act(() => pinnedActionsItem?.action?.());
    expect(onPinnedActionsVisibleChange).toHaveBeenCalledWith(false);
  });

  it("offers the inverse commands when chrome is below and actions are hidden", async () => {
    const onPositionChange = vi.fn();
    const onPinnedActionsVisibleChange = vi.fn();
    act(() => {
      root.render(
        createElement(
          RepoChromeRow,
          {
            pinnedActionsVisible: false,
            position: "bottom",
            onPinnedActionsVisibleChange,
            onPositionChange,
          } as unknown as ComponentProps<typeof RepoChromeRow>,
          createElement("span", null, "repository chrome")
        )
      );
    });

    const row = container.querySelector<HTMLElement>(
      '[data-testid="session-creator-repo-chrome"]'
    );
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    act(() => row?.dispatchEvent(event));

    const popupOptions = mockedPopupNativeMenu.mock.calls[0]?.[0];
    const items = await popupOptions?.buildItems();
    const moveItem = items?.[0] as
      | { text?: string; action?: () => void }
      | undefined;
    const pinnedActionsItem = items?.[2] as
      | { text?: string; action?: () => void }
      | undefined;
    expect(moveItem?.text).toBe("Move to top");
    expect(pinnedActionsItem?.text).toBe("Show pinned actions");

    act(() => moveItem?.action?.());
    expect(onPositionChange).toHaveBeenCalledWith("top");

    act(() => pinnedActionsItem?.action?.());
    expect(onPinnedActionsVisibleChange).toHaveBeenCalledWith(true);
  });
});
