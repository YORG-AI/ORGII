// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { popupNativeMenu } from "@src/util/platform/tauri/nativeMenuPopup";

import ChatPanelTabContextMenu from "./ChatPanelTabContextMenu";

vi.mock("i18next", () => ({
  default: {
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
  },
}));

vi.mock("@src/util/platform/tauri/nativeMenuPopup", () => ({
  popupNativeMenu: vi.fn().mockResolvedValue({ status: "busy" }),
}));

const mockedPopupNativeMenu = vi.mocked(popupNativeMenu);
const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("ChatPanelTabContextMenu", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockedPopupNativeMenu.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("offers Move to My Station when the tab supports it", async () => {
    const onMoveToWorkstation = vi.fn();
    const onDismiss = vi.fn();
    await act(async () => {
      root.render(
        createElement(ChatPanelTabContextMenu, {
          tabId: "chat-pr",
          onMoveToWorkstation,
          onCloseTab: vi.fn(),
          onCloseOtherTabs: vi.fn(),
          onDismiss,
        })
      );
    });

    expect(mockedPopupNativeMenu).toHaveBeenCalledOnce();
    const items = await mockedPopupNativeMenu.mock.calls[0]?.[0].buildItems();
    const moveItem = items?.[0] as
      | { text?: string; action?: () => void }
      | undefined;

    expect(moveItem?.text).toBe("Move to My Station");
    act(() => moveItem?.action?.());
    expect(onMoveToWorkstation).toHaveBeenCalledWith("chat-pr");
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
