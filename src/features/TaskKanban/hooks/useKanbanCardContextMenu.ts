/**
 * Native secondary-click menu for Kanban cards.
 *
 * Mirrors the sidebar's session row menu (`useWorkstationSidebarContextMenu`):
 * a Tauri menu popped at the cursor, so a right-click on a card offers the two
 * open surfaces instead of the WebView's default Reload / Inspect menu.
 */
import { useSetAtom } from "jotai";
import { type MouseEvent, useCallback } from "react";
import { useTranslation } from "react-i18next";

import type { KanbanTask } from "@src/features/KanbanBoard";
import { createLogger } from "@src/hooks/logger";
import { openOrFocusSessionInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { activeStationChatVisibleAtom } from "@src/store/ui/chatPanelAtom";
import {
  type NativeMenuItemOptions,
  popupNativeMenu,
} from "@src/util/platform/tauri/nativeMenuPopup";

import {
  KANBAN_CARD_CONTEXT_ACTION,
  planKanbanCardContextMenu,
} from "../utils/cardContextMenu";

const log = createLogger("TaskKanban");

export interface UseKanbanCardContextMenuParams {
  /**
   * Open the board's floating preview — the same action the primary click
   * performs, including the team-session import it may have to start.
   */
  onOpenFloatingPane: (task: KanbanTask) => void;
  /** Teammate cloud cards keyed by task id, as projected by `useKanbanTasks`. */
  remoteSessionsByTaskId: ReadonlyMap<string, unknown>;
}

export function useKanbanCardContextMenu({
  onOpenFloatingPane,
  remoteSessionsByTaskId,
}: UseKanbanCardContextMenuParams): (
  task: KanbanTask,
  event: MouseEvent
) => void {
  const { t } = useTranslation("sessions");
  const { t: tCommon } = useTranslation("common");
  const openSessionTab = useSetAtom(openOrFocusSessionInChatPanelTabAtom);
  const setStationChatVisible = useSetAtom(activeStationChatVisibleAtom);

  const openInNewTabPane = useCallback(
    (sessionId: string, sessionName: string) => {
      // The board also runs inside a WorkStation tab, where the chat pane can
      // be collapsed — reveal it so the new pill is actually visible.
      setStationChatVisible("my-station", true);
      openSessionTab({ sessionId, sessionName });
    },
    [openSessionTab, setStationChatVisible]
  );

  const showMenu = useCallback(
    async (task: KanbanTask): Promise<void> => {
      const { actions, sessionId } = planKanbanCardContextMenu({
        task,
        isRemoteTeamCard: remoteSessionsByTaskId.has(task.id),
      });
      if (actions.length === 0) return;

      await popupNativeMenu({
        source: "kanban-card",
        buildItems: () => {
          const items: NativeMenuItemOptions[] = [];
          for (const action of actions) {
            if (action === KANBAN_CARD_CONTEXT_ACTION.OpenFloatingPane) {
              items.push({
                text: t("kanban.card.openAsFloatingPane"),
                action: () => onOpenFloatingPane(task),
              });
              continue;
            }
            if (!sessionId) continue;
            items.push({
              text: tCommon("actions.openInNewTab"),
              action: () => openInNewTabPane(sessionId, task.title),
            });
          }
          return items;
        },
      });
    },
    [onOpenFloatingPane, openInNewTabPane, remoteSessionsByTaskId, t, tCommon]
  );

  return useCallback(
    (task: KanbanTask, event: MouseEvent) => {
      // Suppress the WebView menu even when the popup fails — a card that
      // sometimes answers with Reload / Inspect Element reads as a bug.
      event.preventDefault();
      event.stopPropagation();
      void showMenu(task).catch((error) => {
        log.error("Failed to show Kanban card context menu:", error);
      });
    },
    [showMenu]
  );
}

export default useKanbanCardContextMenu;
