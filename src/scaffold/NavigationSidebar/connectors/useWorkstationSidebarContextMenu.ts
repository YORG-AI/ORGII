import {
  MenuItem,
  PredefinedMenuItem,
  Menu as TauriMenu,
} from "@tauri-apps/api/menu";
import { type MouseEvent, useCallback } from "react";

import { createLogger } from "@src/hooks/logger";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { Session } from "@src/store/session";
import { isCursorIdeSession } from "@src/util/session/sessionDispatch";
import { isChatPanelTuiSessionId } from "@src/util/ui/terminal/chatPanelTuiSessionId";

import {
  getDraftIdFromMenuItemId,
  isDraftMenuItemId,
} from "./sidebarConnectorUtils";
import type { UseRenameSessionModalResult } from "./useRenameSessionModal";

const log = createLogger("WorkstationSidebar");

interface UseWorkstationSidebarContextMenuParams {
  sessionMap: Map<string, Session>;
  rename: UseRenameSessionModalResult;
  handleDeleteSession: (sessionId: string) => Promise<void>;
  handleDeleteDraft: (draftId: string) => void;
  handleExportMarkdown: (sessionId: string) => Promise<void>;
  handleOpenInNewTab: (sessionId: string) => void;
  handleTogglePin: (sessionId: string) => Promise<void>;
  onLinkToWorkItem?: (sessionId: string) => void;
  tCommon: (key: string, defaultValue?: string) => string;
}

export function useWorkstationSidebarContextMenu({
  sessionMap,
  rename,
  handleDeleteSession,
  handleDeleteDraft,
  handleExportMarkdown,
  handleOpenInNewTab,
  handleTogglePin,
  onLinkToWorkItem,
  tCommon,
}: UseWorkstationSidebarContextMenuParams): (
  event: MouseEvent,
  _key: string,
  item: NavigationMenuItem
) => Promise<void> {
  return useCallback(
    async (event: MouseEvent, _key: string, item: NavigationMenuItem) => {
      event.preventDefault();
      event.stopPropagation();

      if (isDraftMenuItemId(item.id)) {
        const draftId = getDraftIdFromMenuItemId(item.id);
        if (!draftId) return;
        const removeDraftItem = await MenuItem.new({
          text: tCommon("sessions:sidebar.removeDraft", "Remove draft"),
          action: () => handleDeleteDraft(draftId),
        });
        const menu = await TauriMenu.new({ items: [removeDraftItem] });
        await menu.popup();
        return;
      }

      if (!sessionMap.has(item.id)) return;

      const isCursorIde = isCursorIdeSession(item.id);
      const session = sessionMap.get(item.id);

      // Subagent rows have no meaningful row-level actions.
      if (session?.parentSessionId || item.id.includes(":subagent:")) return;

      try {
        const openInNewTabItem = await MenuItem.new({
          text: tCommon("actions.openInNewTab", "Open in New Tab"),
          action: () => handleOpenInNewTab(item.id),
        });
        const pinLabel = session?.pinned
          ? tCommon("sessions:chat.unpinSession", "Unpin")
          : tCommon("sessions:chat.pinSession", "Pin");
        const pinItem = await MenuItem.new({
          text: pinLabel,
          action: () => handleTogglePin(item.id),
        });

        if (isCursorIde) {
          const menu = await TauriMenu.new({
            items: [openInNewTabItem, pinItem],
          });
          await menu.popup();
          return;
        }

        if (isChatPanelTuiSessionId(item.id)) {
          const deleteItem = await MenuItem.new({
            text: tCommon("actions.delete"),
            action: () => handleDeleteSession(item.id),
          });
          const menu = await TauriMenu.new({
            items: [openInNewTabItem, pinItem, deleteItem],
          });
          await menu.popup();
          return;
        }

        const renameItem = await MenuItem.new({
          text: tCommon("actions.rename"),
          action: () => rename.open(item.id, sessionMap),
        });
        const exportItem = await MenuItem.new({
          text: tCommon("sessions:chat.exportAsMarkdown", "Export as Markdown"),
          action: () => handleExportMarkdown(item.id),
        });
        const linkWorkItem = await MenuItem.new({
          text: tCommon(
            "sessions:chat.linkToWorkItem",
            "Link to project / Work Item"
          ),
          action: () => onLinkToWorkItem?.(item.id),
        });
        const deleteItem = await MenuItem.new({
          text: tCommon("actions.delete"),
          action: () => handleDeleteSession(item.id),
        });
        const menuSeparator = await PredefinedMenuItem.new({
          item: "Separator",
        });
        const primaryItems = [
          openInNewTabItem,
          renameItem,
          exportItem,
          pinItem,
          linkWorkItem,
        ];
        const menu = await TauriMenu.new({
          items: [...primaryItems, menuSeparator, deleteItem],
        });
        await menu.popup();
      } catch (error) {
        log.error("[WorkstationSidebar] Context menu failed:", error);
      }
    },
    [
      sessionMap,
      tCommon,
      rename,
      handleDeleteSession,
      handleDeleteDraft,
      handleExportMarkdown,
      handleOpenInNewTab,
      handleTogglePin,
      onLinkToWorkItem,
    ]
  );
}
