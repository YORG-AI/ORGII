// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { popupNativeMenu } from "@src/util/platform/tauri/nativeMenuPopup";

import { usePinnedActionsVisibilityContextMenu } from "./usePinnedActionsVisibilityContextMenu";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key.endsWith(".hidePinnedActions")
        ? "Hide pinned actions"
        : "Show pinned actions",
  }),
}));

vi.mock("@src/util/platform/tauri/nativeMenuPopup", () => ({
  popupNativeMenu: vi.fn().mockResolvedValue({ status: "closed" }),
}));

const mockedPopupNativeMenu = vi.mocked(popupNativeMenu);
const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function MenuTarget({
  visible,
  onVisibleChange,
}: {
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
}) {
  const onContextMenu = usePinnedActionsVisibilityContextMenu({
    visible,
    onVisibleChange,
  });
  return createElement("div", { "data-testid": "target", onContextMenu });
}

describe("usePinnedActionsVisibilityContextMenu", () => {
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

  it("opens the hide command from a composer context menu", async () => {
    const onVisibleChange = vi.fn();
    act(() => {
      root.render(
        createElement(MenuTarget, { visible: true, onVisibleChange })
      );
    });

    const target = container.querySelector('[data-testid="target"]');
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    act(() => target?.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(mockedPopupNativeMenu).toHaveBeenCalledOnce();
    const items = await mockedPopupNativeMenu.mock.calls[0]?.[0].buildItems();
    const visibilityItem = items?.[0] as
      | { text?: string; action?: () => void }
      | undefined;
    expect(visibilityItem?.text).toBe("Hide pinned actions");

    act(() => visibilityItem?.action?.());
    expect(onVisibleChange).toHaveBeenCalledWith(false);
  });
});
