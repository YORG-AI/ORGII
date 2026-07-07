import {
  ChevronsDownUp,
  ChevronsUpDown,
  MoreHorizontal,
  Pin,
  PinOff,
  X,
} from "lucide-react";
import React, { useCallback } from "react";

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

interface BuildSessionRowActionsParams {
  activeSessionMoreMenuId: string;
  handleMenuItemContextMenu: (
    event: React.MouseEvent<HTMLButtonElement>,
    key: string,
    item: NavigationMenuItem
  ) => Promise<void>;
  handleTogglePin: (sessionId: string) => Promise<void> | void;
  item: NavigationMenuItem;
  session: Session;
  setActiveSessionMoreMenuId: React.Dispatch<React.SetStateAction<string>>;
  tCommon: TCommon;
  pinLabel: string;
  unpinLabel: string;
}

export function buildSessionRowActions({
  activeSessionMoreMenuId,
  handleMenuItemContextMenu,
  handleTogglePin,
  item,
  session,
  setActiveSessionMoreMenuId,
  tCommon,
  pinLabel,
  unpinLabel,
}: BuildSessionRowActionsParams): NavigationMenuRowAction[] {
  const rowActions: NavigationMenuRowAction[] = [];
  if (!isChatPanelTuiSessionId(item.id)) {
    rowActions.push({
      icon: session.pinned ? PinOff : Pin,
      label: session.pinned ? unpinLabel : pinLabel,
      onClick: () => {
        void handleTogglePin(item.id);
      },
    });
  }
  if (!isCursorIdeSession(item.id)) {
    rowActions.push({
      icon: MoreHorizontal,
      label: tCommon("actions.more", "More actions"),
      active: activeSessionMoreMenuId === item.id,
      onClick: (event) => {
        setActiveSessionMoreMenuId(item.id);
        void handleMenuItemContextMenu(event, item.key, item).finally(() => {
          setActiveSessionMoreMenuId((currentId) =>
            currentId === item.id ? "" : currentId
          );
        });
      },
    });
  }
  return rowActions;
}

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
  const decorateSessionItems = useCallback(
    (items: readonly NavigationMenuItem[]): NavigationMenuItem[] => {
      const decorateItem = (item: NavigationMenuItem): NavigationMenuItem => {
        const decoratedChildren = item.children
          ? item.children.map(decorateItem)
          : undefined;
        const baseItem = decoratedChildren
          ? { ...item, children: decoratedChildren }
          : item;
        const draftId = getDraftIdFromMenuItemId(item.id);
        if (draftId) {
          return {
            ...baseItem,
            showMoreActions: true,
            rowActions: [
              {
                icon: X,
                label: tCommon("sessions:sidebar.removeDraft", "Remove draft"),
                onClick: () => deleteSessionCreatorDraft(draftId),
              },
            ],
          };
        }

        const session = sessionMap.get(item.id);
        if (!session) return baseItem;
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
            icon: expanded ? ChevronsDownUp : ChevronsUpDown,
            label: expanded
              ? tCommon("sessions:sidebar.hideSubagents", "Hide subagents")
              : tCommon("sessions:sidebar.showSubagents", "Show subagents"),
            active: expanded,
            onClick: () => handleToggleSubagentExpansion(item.id),
          });
        }
        if (!isChildSession && !isChatPanelTuiSessionId(item.id)) {
          rowActions.push({
            icon: session.pinned ? PinOff : Pin,
            label: session.pinned ? unpinLabel : pinLabel,
            onClick: () => {
              void handleTogglePin(item.id);
            },
          });
        }
        if (!isCursorIdeSession(item.id)) {
          rowActions.push({
            icon: MoreHorizontal,
            label: tCommon("actions.more"),
            active: activeSessionMoreMenuId === item.id,
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
          ...baseItem,
          // # ORG2 tree sessions can be nested under child rows; recursive decoration must explicitly enable the action slot so NavigationMenuRow swaps the timestamp for pin/more actions on hover.
          showMoreActions: true,
          rowActions,
        };
      };

      return items.map(decorateItem);
    },
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

  return decorateSessionItems;
}
