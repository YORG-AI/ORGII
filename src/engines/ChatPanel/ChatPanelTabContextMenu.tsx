import { MenuItem, Menu as TauriMenu } from "@tauri-apps/api/menu";
import i18next from "i18next";
import { useEffect, useRef } from "react";

import { createLogger } from "@src/hooks/logger";

const logger = createLogger("ChatPanelTabContextMenu");

export interface ChatPanelTabContextMenuProps {
  tabId: string;
  onCloseTab: (tabId: string) => void | Promise<void>;
  onCloseOtherTabs: (tabId: string) => void | Promise<void>;
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
        const translate = i18next.t.bind(i18next);
        const [closeItem, closeOthersItem] = await Promise.all([
          MenuItem.new({
            text: translate("actions.close"),
            action: () => {
              const current = propsRef.current;
              void current.onCloseTab(current.tabId);
              current.onDismiss();
            },
          }),
          MenuItem.new({
            text: translate("actions.closeOthers"),
            action: () => {
              const current = propsRef.current;
              void current.onCloseOtherTabs(current.tabId);
              current.onDismiss();
            },
          }),
        ]);
        const menu = await TauriMenu.new({
          items: [closeItem, closeOthersItem],
        });
        await menu.popup();
        setTimeout(() => propsRef.current.onDismiss(), 50);
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
