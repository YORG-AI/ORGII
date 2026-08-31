// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { popupNativeMenu } from "@src/util/platform/tauri/nativeMenuPopup";

import { TabContextMenu } from "./TabContextMenu";

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

describe("WorkStation TabContextMenu", () => {
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

  it("offers Move to Chat Panel for a movable PR tab", async () => {
    const onMoveToChatPanel = vi.fn();
    const onClose = vi.fn();
    const tab = {
      id: "github-pr-detail:/repo:1028",
      type: "github-pr-detail" as const,
      title: "#1028",
      data: {
        prNumber: 1028,
        prTitle: "Add autostash to rebase pulls",
        prUrl: "https://github.com/org/repo/pull/1028",
        prStatus: "merged",
        headBranch: "fix/pull-rebase-autostash",
        repoPath: "/repo",
      },
    };

    await act(async () => {
      root.render(
        createElement(TabContextMenu, {
          position: { x: 0, y: 0 },
          tab,
          repoPath: "/repo",
          onClose,
          onCloseTab: vi.fn(),
          onCloseOtherTabs: vi.fn(),
          onCloseSavedTabs: vi.fn(),
          onMoveToChatPanel,
        })
      );
    });

    const items = await mockedPopupNativeMenu.mock.calls[0]?.[0].buildItems();
    const moveItem = items?.find(
      (item) => "text" in item && item.text === "Move to Chat Panel"
    ) as { action?: () => void } | undefined;

    expect(moveItem).toBeDefined();
    act(() => moveItem?.action?.());
    expect(onMoveToChatPanel).toHaveBeenCalledWith(tab);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
