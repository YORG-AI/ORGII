// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { Session } from "@src/store/session";
import { popupNativeMenu } from "@src/util/platform/tauri/nativeMenuPopup";

import { useWorkstationSidebarContextMenu } from "../useWorkstationSidebarContextMenu";

vi.mock("@src/util/platform/tauri/nativeMenuPopup", () => ({
  popupNativeMenu: vi.fn().mockResolvedValue({ status: "closed" }),
}));

const mockedPopupNativeMenu = vi.mocked(popupNativeMenu);
const translate = (key: string, defaultValue?: string) => defaultValue ?? key;

function session(sessionId: string): Session {
  return {
    session_id: sessionId,
    name: `Session ${sessionId}`,
    status: "completed",
    created_at: "2026-09-03T00:00:00Z",
    updated_at: "2026-09-03T00:00:00Z",
  };
}

describe("useWorkstationSidebarContextMenu", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockedPopupNativeMenu.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("offers the detached-window action for every supported local session menu", async () => {
    const sessions = [
      session("sdeagent-local"),
      session("cursoride-imported"),
      session("chatpaneltui-terminal"),
    ];
    const sessionMap = new Map(
      sessions.map((row) => [row.session_id, row] as const)
    );
    const handleOpenInNewWindow = vi.fn();
    let openMenu:
      | ReturnType<typeof useWorkstationSidebarContextMenu>
      | undefined;

    function Probe(): null {
      const value = useWorkstationSidebarContextMenu({
        sessionMap,
        rename: {
          visible: false,
          currentName: "",
          loading: false,
          open: vi.fn(),
          onConfirm: vi.fn(async () => undefined),
          onCancel: vi.fn(),
          renameSessionId: null,
        },
        handleDeleteSession: vi.fn(async () => undefined),
        handleDeleteDraft: vi.fn(),
        handleOpenDraftInNewTab: vi.fn(),
        handleExportMarkdown: vi.fn(async () => undefined),
        handleOpenInNewTab: vi.fn(),
        handleOpenInNewWindow,
        handleOpenInMyStation: vi.fn(),
        handleTogglePin: vi.fn(async () => undefined),
        isMoveEligible: () => false,
        handleOpenMoveToOrg: vi.fn(),
        moveToOrgLabel: "Move to organization",
        isCloudSyncLevelEligible: () => false,
        handleOpenCloudSyncLevel: vi.fn(),
        cloudSyncLevelLabel: "Cloud sync",
        isCloudShareEligible: () => false,
        handleOpenCloudShare: vi.fn(),
        cloudShareLabel: "Share",
        isCopyReferenceEligible: () => false,
        handleCopyReference: vi.fn(),
        copyReferenceLabel: "Copy URL",
        tCommon: translate,
      });
      useEffect(() => {
        openMenu = value;
      }, [value]);
      return null;
    }

    await act(async () => root.render(createElement(Probe)));
    if (!openMenu) throw new Error("context menu hook did not render");

    for (const row of sessions) {
      const item: NavigationMenuItem = {
        id: row.session_id,
        key: row.session_id,
        label: row.name ?? row.session_id,
      };
      const event = {
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as never;

      await openMenu(event, item.key, item);
      const popupOptions = mockedPopupNativeMenu.mock.lastCall?.[0];
      const items = await popupOptions?.buildItems();
      const detachedWindowItem = items?.find(
        (menuItem) =>
          "text" in menuItem && menuItem.text === "Open in New Window"
      );

      expect(detachedWindowItem).toBeDefined();
      if (detachedWindowItem && "action" in detachedWindowItem) {
        detachedWindowItem.action?.("open-in-new-window");
      }
      expect(handleOpenInNewWindow).toHaveBeenLastCalledWith(row.session_id);
    }
  });
});
