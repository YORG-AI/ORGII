import React, { useCallback } from "react";

import {
  Cancel01Icon,
  ChevronsDownUpIcon,
  MoreHorizontalIcon,
  PinIcon,
  PinOffIcon,
  UnfoldMoreIcon,
} from "@src/icons";
import type {
  NavigationMenuItem,
  NavigationMenuRowAction,
} from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { Session } from "@src/store/session";
import { isCursorIdeSession } from "@src/util/session/sessionDispatch";
import { isChatPanelTuiSessionId } from "@src/util/ui/terminal/chatPanelTuiSessionId";

import { getDraftIdFromMenuItemId } from "../sidebarConnectorUtils";

type TCommon = (key: string, defaultValue?: string) => string;

const SUBAGENT_SESSION_ID_SEGMENT = ":subagent:";

interface UseSessionRowActionsParams {
  activeSessionMoreMenuId: string;
  deleteSessionCreatorDraft: (draftId: string) => void;
  handleMenuItemContextMenu: (
    event: React.MouseEvent<HTMLButtonElement>,
    key: string,
    item: NavigationMenuItem
  ) => Promise<void>;
  handleTogglePin: (sessionId: string) => Promise<void> | void;
  handleToggleSubagentExpansion: (sessionId: string) => void;
  expandedSubagentParentIds: ReadonlySet<string>;
  pinLabel: string;
  sessionMap: ReadonlyMap<string, Session>;
  setActiveSessionMoreMenuId: React.Dispatch<React.SetStateAction<string>>;
  subagentParentIds: ReadonlySet<string>;
  tCommon: TCommon;
  unpinLabel: string;
}

export function useDecorateSessionRowActions({
  activeSessionMoreMenuId,
  deleteSessionCreatorDraft,
  handleMenuItemContextMenu,
  handleTogglePin,
  handleToggleSubagentExpansion,
  expandedSubagentParentIds,
  pinLabel,
  sessionMap,
  setActiveSessionMoreMenuId,
  subagentParentIds,
  tCommon,
  unpinLabel,
}: UseSessionRowActionsParams): (
  items: readonly NavigationMenuItem[]
) => NavigationMenuItem[] {
  return useCallback(
    (items: readonly NavigationMenuItem[]): NavigationMenuItem[] =>
      items.map((item) => {
        const draftId = getDraftIdFromMenuItemId(item.id);
        if (draftId) {
          return {
            ...item,
            showMoreActions: true,
            rowActions: [
              {
                icon: Cancel01Icon,
                label: tCommon("sessions:sidebar.removeDraft", "Remove draft"),
                onClick: () => deleteSessionCreatorDraft(draftId),
              },
            ],
          };
        }

        const session = sessionMap.get(item.id);
        if (!session) return item;
        const rowActions: NavigationMenuRowAction[] = [];
        const isChildSession =
          Boolean(session.parentSessionId) ||
          item.id.includes(SUBAGENT_SESSION_ID_SEGMENT);
        // Subagent rows have no pin/more-menu affordances.
        if (isChildSession) return item;
        const hasSubagentChildren = subagentParentIds.has(item.id);
        if (hasSubagentChildren) {
          const expanded = expandedSubagentParentIds.has(item.id);
          rowActions.push({
            icon: expanded ? ChevronsDownUpIcon : UnfoldMoreIcon,
            label: expanded
              ? tCommon("sessions:sidebar.hideSubagents", "Hide subagents")
              : tCommon("sessions:sidebar.showSubagents", "Show subagents"),
            onClick: () => handleToggleSubagentExpansion(item.id),
          });
        }
        if (!isChildSession && !isChatPanelTuiSessionId(item.id)) {
          rowActions.push({
            icon: session.pinned ? PinOffIcon : PinIcon,
            label: session.pinned ? unpinLabel : pinLabel,
            onClick: () => {
              void handleTogglePin(item.id);
            },
          });
        }
        if (!isCursorIdeSession(item.id)) {
          rowActions.push({
            icon: MoreHorizontalIcon,
            label: tCommon("actions.more"),
            active: activeSessionMoreMenuId === item.id,
            dataTestId: `sidebar-session-more-${item.id}`,
            onClick: (event) => {
              setActiveSessionMoreMenuId(item.id);
              void handleMenuItemContextMenu(event, item.key, item).finally(
                () => {
                  setActiveSessionMoreMenuId((currentId) =>
                    currentId === item.id ? "" : currentId
                  );
                }
              );
            },
          });
        }
        return {
          ...item,
          showMoreActions: true,
          rowActions,
        };
      }),
    [
      activeSessionMoreMenuId,
      deleteSessionCreatorDraft,
      handleMenuItemContextMenu,
      handleTogglePin,
      handleToggleSubagentExpansion,
      expandedSubagentParentIds,
      pinLabel,
      sessionMap,
      setActiveSessionMoreMenuId,
      subagentParentIds,
      tCommon,
      unpinLabel,
    ]
  );
}
