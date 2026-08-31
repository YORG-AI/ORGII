import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { createLogger } from "@src/hooks/logger";
import { popupNativeMenu } from "@src/util/platform/tauri/nativeMenuPopup";

const log = createLogger("PinnedActionsVisibilityContextMenu");

interface UsePinnedActionsVisibilityContextMenuOptions {
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
}

/** Native show/hide menu shared by creator and active-session composers. */
export function usePinnedActionsVisibilityContextMenu({
  visible,
  onVisibleChange,
}: UsePinnedActionsVisibilityContextMenuOptions): React.MouseEventHandler<HTMLElement> {
  const { t } = useTranslation("sessions");

  return useCallback(
    (event) => {
      event.preventDefault();
      event.stopPropagation();

      void popupNativeMenu({
        source: "pinned-actions-visibility",
        buildItems: () => [
          {
            text: t(
              visible
                ? "creator.repoChromeMenu.hidePinnedActions"
                : "creator.repoChromeMenu.showPinnedActions"
            ),
            action: () => onVisibleChange(!visible),
          },
        ],
      }).catch((error) => {
        log.error("Failed to show pinned-actions visibility menu:", error);
      });
    },
    [onVisibleChange, t, visible]
  );
}
