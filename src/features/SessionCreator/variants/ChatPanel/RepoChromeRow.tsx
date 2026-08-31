import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { createLogger } from "@src/hooks/logger";
import type { CreatorRepoChromePosition } from "@src/store/session";
import {
  type NativeMenuItemOptions,
  popupNativeMenu,
} from "@src/util/platform/tauri/nativeMenuPopup";

import { REPO_CHROME_POSITION_CLASS } from "./repoChromeLayout";

const log = createLogger("RepoChromeRow");

export interface RepoChromeRowProps {
  children: React.ReactNode;
  pinnedActionsVisible: boolean;
  position: CreatorRepoChromePosition;
  onPinnedActionsVisibleChange: (visible: boolean) => void;
  onPositionChange: (position: CreatorRepoChromePosition) => void;
}

/** Repository controls row with a native layout/visibility secondary-click menu. */
export const RepoChromeRow: React.FC<RepoChromeRowProps> = ({
  children,
  pinnedActionsVisible,
  position,
  onPinnedActionsVisibleChange,
  onPositionChange,
}) => {
  const { t } = useTranslation("sessions");
  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();

      void popupNativeMenu({
        source: "session-creator-repo-chrome",
        buildItems: () => {
          const items: NativeMenuItemOptions[] = [
            {
              text: t(
                position === "top"
                  ? "creator.repoChromeMenu.moveToBottom"
                  : "creator.repoChromeMenu.moveToTop"
              ),
              action: () =>
                onPositionChange(position === "top" ? "bottom" : "top"),
            },
            { item: "Separator" },
            {
              text: t(
                pinnedActionsVisible
                  ? "creator.repoChromeMenu.hidePinnedActions"
                  : "creator.repoChromeMenu.showPinnedActions"
              ),
              action: () => onPinnedActionsVisibleChange(!pinnedActionsVisible),
            },
          ];
          return items;
        },
      }).catch((error) => {
        log.error("Failed to show repository chrome context menu:", error);
      });
    },
    [
      onPinnedActionsVisibleChange,
      onPositionChange,
      pinnedActionsVisible,
      position,
      t,
    ]
  );

  return (
    <div
      className={`session-creator-chat-panel-fullscreen-repo-row px-1 ${REPO_CHROME_POSITION_CLASS[position]}`}
      data-testid="session-creator-repo-chrome"
      onContextMenu={handleContextMenu}
    >
      {children}
    </div>
  );
};

export default RepoChromeRow;
