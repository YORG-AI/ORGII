import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Provider, createStore } from "jotai";
import React from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { repoApi } from "@src/api/tauri/repo";
import { showNativeMessageSafely } from "@src/util/dialogs/nativeDialog";
import { popupNativeMenu } from "@src/util/platform/tauri/nativeMenuPopup";

import { NO_WORKSPACE_KEY } from "../types";
import type { WorkspaceGroupActions } from "../useSessionMenuItems/types";
import { useWorkspaceGroupActions } from "./useWorkspaceGroupActions";

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@src/util/dialogs/nativeDialog", () => ({
  showNativeMessageSafely: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@src/api/tauri/repo", () => ({
  repoApi: {
    validateWorkspacePath: vi.fn(),
  },
}));

vi.mock("@src/util/platform/tauri/nativeMenuPopup", () => ({
  popupNativeMenu: vi.fn().mockResolvedValue({ status: "closed" }),
}));

const mockedPopupNativeMenu = vi.mocked(popupNativeMenu);
const mockedRevealItemInDir = vi.mocked(revealItemInDir);
const mockedValidateWorkspacePath = vi.mocked(repoApi.validateWorkspacePath);
const mockedShowNativeMessageSafely = vi.mocked(showNativeMessageSafely);

function renderWorkspaceGroupActions(): WorkspaceGroupActions {
  const store = createStore();
  let actions: WorkspaceGroupActions | undefined;

  function HookProbe(): null {
    // eslint-disable-next-line react-hooks/globals -- server-rendered test probe synchronously exports the hook result; the component never mounts or re-renders
    actions = useWorkspaceGroupActions({
      createSessionLabel: "New session",
      moreActionsLabel: "More actions",
      pinLabel: "Pin workspace",
      unpinLabel: "Unpin workspace",
      hideLabel: "Hide workspace",
      unhideLabel: "Unhide workspace",
      revealLabel: "Reveal in file manager",
      unavailableTitle: "Workspace no longer available",
      unavailableMessage: "This Workspace may have been moved or deleted.",
      openNewSession: vi.fn(),
      setCollapsedSectionIds: vi.fn(),
    });
    return null;
  }

  renderToString(
    React.createElement(Provider, { store }, React.createElement(HookProbe))
  );

  if (!actions) throw new Error("workspace group actions did not render");
  return actions;
}

describe("useWorkspaceGroupActions", () => {
  beforeEach(() => {
    mockedPopupNativeMenu.mockClear();
    mockedRevealItemInDir.mockClear();
    mockedValidateWorkspacePath.mockReset();
    mockedValidateWorkspacePath.mockImplementation(async (path) => path);
    mockedShowNativeMessageSafely.mockClear();
  });

  it("reveals actual workspace groups in the OS file manager", async () => {
    const actions = renderWorkspaceGroupActions();
    actions.onOpenMenu("/workspace/orgii");

    const popupOptions = mockedPopupNativeMenu.mock.calls[0]?.[0];
    const items = await popupOptions?.buildItems();
    expect(
      items?.map((item) => ("text" in item ? item.text : item.item))
    ).toEqual([
      "Reveal in file manager",
      "Separator",
      "Pin workspace",
      "Hide workspace",
    ]);

    const revealItem = items?.[0];
    if (revealItem && "action" in revealItem) {
      revealItem.action?.("reveal-workspace");
    }
    await vi.waitFor(() => {
      expect(mockedRevealItemInDir).toHaveBeenCalledWith("/workspace/orgii");
    });
    expect(mockedShowNativeMessageSafely).not.toHaveBeenCalled();
  });

  it("shows a native warning when the workspace folder no longer exists", async () => {
    mockedValidateWorkspacePath.mockRejectedValue(
      new Error("Unable to access workspace path")
    );
    const actions = renderWorkspaceGroupActions();
    actions.onOpenMenu("/workspace/missing");

    const popupOptions = mockedPopupNativeMenu.mock.calls[0]?.[0];
    const items = await popupOptions?.buildItems();
    const revealItem = items?.[0];
    if (revealItem && "action" in revealItem) {
      revealItem.action?.("reveal-workspace");
    }

    await vi.waitFor(() => {
      expect(mockedShowNativeMessageSafely).toHaveBeenCalledWith(
        "This Workspace may have been moved or deleted.\n\n/workspace/missing",
        {
          title: "Workspace no longer available",
          kind: "warning",
        }
      );
    });
    expect(mockedRevealItemInDir).not.toHaveBeenCalled();
  });

  it("omits reveal for the synthetic no-workspace group", async () => {
    const actions = renderWorkspaceGroupActions();
    actions.onOpenMenu(NO_WORKSPACE_KEY);

    const popupOptions = mockedPopupNativeMenu.mock.calls[0]?.[0];
    const items = await popupOptions?.buildItems();
    expect(
      items?.map((item) => ("text" in item ? item.text : item.item))
    ).toEqual(["Pin workspace", "Hide workspace"]);
    expect(mockedRevealItemInDir).not.toHaveBeenCalled();
  });
});
