import i18next from "i18next";
import { useEffect, useRef } from "react";

import { createLogger } from "@src/hooks/logger";
import type { SessionReferenceOpen } from "@src/shared/dnd/sessionTabDrag";
import {
  type NativeMenuItemOptions,
  popupNativeMenu,
} from "@src/util/platform/tauri/nativeMenuPopup";

const logger = createLogger("ChatPanelTabContextMenu");

export interface ChatPanelTabContextMenuProps {
  tabId: string;
  onCloseTab: (tabId: string) => void | Promise<void>;
  onCloseOtherTabs: (tabId: string) => void | Promise<void>;
  onMoveToWorkstation?: (tabId: string) => void | Promise<void>;
  sessionReference?: SessionReferenceOpen;
  onCreateWorkItem?: (reference: SessionReferenceOpen) => void;
  onOpenInSideChat?: (reference: SessionReferenceOpen) => void;
  onDismiss: () => void;
}

/** Native close-actions menu shown when a Chat Panel tab is right-clicked. */
export function ChatPanelTabContextMenu(
  props: ChatPanelTabContextMenuProps
): null {
  const propsRef = useRef(props);
  const hasShownMenu = useRef(false);

  useEffect(() => {
    propsRef.current = props;
  }, [props]);

  useEffect(() => {
    if (hasShownMenu.current) return;
    hasShownMenu.current = true;

    async function showNativeMenu(): Promise<void> {
      try {
        const result = await popupNativeMenu({
          source: "chat-panel-tab",
          onBusy: () => propsRef.current.onDismiss(),
          buildItems: () => {
            const translate = i18next.t.bind(i18next);
            const items: NativeMenuItemOptions[] = [];
            if (propsRef.current.onMoveToWorkstation) {
              items.push({
                text: translate("sessions:chat.moveToWorkstation", {
                  defaultValue: "Move to My Station",
                }),
                action: () => {
                  const current = propsRef.current;
                  void current.onMoveToWorkstation?.(current.tabId);
                  current.onDismiss();
                },
              });
            }
            const sessionReference = propsRef.current.sessionReference;
            if (sessionReference) {
              items.push({
                text: translate("sessions:chat.sideChat.openInSideChat", {
                  defaultValue: "Open in Side Chat",
                }),
                action: () => {
                  const current = propsRef.current;
                  if (current.sessionReference) {
                    current.onOpenInSideChat?.(current.sessionReference);
                  }
                  current.onDismiss();
                },
              });
              items.push({
                text: translate("teamInbox.handoff.createFromSession", {
                  defaultValue: "Create team Work Item…",
                }),
                action: () => {
                  const current = propsRef.current;
                  if (current.sessionReference) {
                    current.onCreateWorkItem?.(current.sessionReference);
                  }
                  current.onDismiss();
                },
              });
            }
            items.push(
              {
                text: translate("actions.close"),
                action: () => {
                  const current = propsRef.current;
                  void current.onCloseTab(current.tabId);
                  current.onDismiss();
                },
              },
              {
                text: translate("actions.closeOthers"),
                action: () => {
                  const current = propsRef.current;
                  void current.onCloseOtherTabs(current.tabId);
                  current.onDismiss();
                },
              }
            );
            return items;
          },
        });
        if (result.status !== "busy") {
          setTimeout(() => propsRef.current.onDismiss(), 50);
        }
      } catch (error) {
        logger.error("Failed to show native context menu:", error);
        propsRef.current.onDismiss();
      }
    }

    void showNativeMenu();
  }, []);

  return null;
}

export default ChatPanelTabContextMenu;
