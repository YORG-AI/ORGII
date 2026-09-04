/** Native trail menu. The trail has a fixed size; only its terminal resizes. */
import i18next from "i18next";
import { type MouseEvent, useCallback } from "react";

import { createLogger } from "@src/hooks/logger";
import { popupNativeMenu } from "@src/util/platform/tauri/nativeMenuPopup";

const log = createLogger("useWorkstationTrailMenu");

export interface UseWorkstationTrailMenuOptions {
  miniTerminalVisible: boolean;
  onOpenMiniTerminal: () => void;
  onHideMiniTerminal: () => void;
}

export function useWorkstationTrailMenu({
  miniTerminalVisible,
  onOpenMiniTerminal,
  onHideMiniTerminal,
}: UseWorkstationTrailMenuOptions) {
  return useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      void popupNativeMenu({
        source: "workstation-trail",
        buildItems: () => [
          miniTerminalVisible
            ? {
                text: i18next.t("common:git.rail.hideMiniTerminal"),
                action: onHideMiniTerminal,
              }
            : {
                text: i18next.t("common:git.rail.openMiniTerminal"),
                action: onOpenMiniTerminal,
              },
        ],
      }).catch((error) => {
        log.error("Failed to show workstation trail menu:", error);
      });
    },
    [miniTerminalVisible, onHideMiniTerminal, onOpenMiniTerminal]
  );
}
