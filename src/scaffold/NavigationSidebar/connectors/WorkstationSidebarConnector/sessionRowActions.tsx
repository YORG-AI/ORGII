import { MoreHorizontal, Pin, PinOff, X } from "lucide-react";
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

interface UseSessionRowActionsParams {
  activeSessionMoreMenuId: string;
  deleteSessionCreatorDraft: (draftId: string) => void;
  handleMenuItemContextMenu: (
    event: React.MouseEvent<HTMLButtonElement>,
    key: string,
    item: NavigationMenuItem
  ) => Promise<void>;
  handleTogglePin: (sessionId: string) => Promise<void> | void;
  pinLabel: string;
  sessionMap: ReadonlyMap<string, Session>;
  setActiveSessionMoreMenuId: React.Dispatch<React.SetStateAction<string>>;
  tCommon: TCommon;
  unpinLabel: string;
}

export function useDecorateSessionRowActions({
  activeSessionMoreMenuId,
  deleteSessionCreatorDraft,
  handleMenuItemContextMenu,
  handleTogglePin,
  pinLabel,
  sessionMap,
  setActiveSessionMoreMenuId,
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
          // # ORG2 树 session 藏在 children 里；递归装饰后必须显式打开 action slot，
          // # NavigationMenuRow 才会在 hover 时把时间切成置顶/更多按钮。
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
      pinLabel,
      sessionMap,
      setActiveSessionMoreMenuId,
      tCommon,
      unpinLabel,
    ]
  );

  return decorateSessionItems;
}
