/**
 * Right-click menu for the Workstation trail's resize handle.
 *
 * Width commands:
 *   - "Restore original width" — back to the shipped 256px. It also clears a
 *     user-set minimum, because a minimum above 256px would otherwise make
 *     the command a no-op with no way back from the menu.
 *   - "Set current width as minimum" — pins the trail's *current* width as
 *     the floor for dragging. It never resizes the trail.
 *   - "Wider" — one `step` up, disabled at the maximum.
 *
 * Terminal commands open / hide the terminal docked under the trail, which
 * is the trail's terminal entry point now that the Workstation-navigating
 * terminal, files and browser rows are gone.
 */
import i18next from "i18next";
import { type MouseEvent, useCallback } from "react";

import { createLogger } from "@src/hooks/logger";
import {
  type NativeMenuItemOptions,
  popupNativeMenu,
} from "@src/util/platform/tauri/nativeMenuPopup";

import {
  WORKSTATION_TRAIL_WIDTH_LIMITS,
  resolveNextWiderTrailWidth,
} from "./trailWidth";

const log = createLogger("useWorkstationTrailMenu");

export interface UseWorkstationTrailMenuOptions {
  /** Current expanded width in px. */
  width: number;
  /** Effective minimum width in px (user-set or the shipped floor). */
  minWidth: number;
  onWidthChange: (width: number) => void;
  /** Persist `width` as the new minimum without resizing the trail. */
  onSetMinimum: () => void;
  /** Restore the shipped width and clear a user-set minimum. */
  onRestoreDefault: () => void;
  /** Mini terminal currently on screen. */
  miniTerminalVisible: boolean;
  onOpenMiniTerminal: () => void;
  onHideMiniTerminal: () => void;
}

export function useWorkstationTrailMenu({
  width,
  minWidth,
  onWidthChange,
  onSetMinimum,
  onRestoreDefault,
  miniTerminalVisible,
  onOpenMiniTerminal,
  onHideMiniTerminal,
}: UseWorkstationTrailMenuOptions) {
  return useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const isDefaultWidth = width === WORKSTATION_TRAIL_WIDTH_LIMITS.default;
      const nextWider = resolveNextWiderTrailWidth(width, minWidth);
      const isAlreadyMinimum = minWidth === width;

      void popupNativeMenu({
        source: "workstation-trail",
        buildItems: () => {
          const items: NativeMenuItemOptions[] = [
            {
              text: i18next.t("common:git.rail.restoreWidth", {
                width: WORKSTATION_TRAIL_WIDTH_LIMITS.default,
              }),
              enabled: !isDefaultWidth,
              action: onRestoreDefault,
            },
            {
              text: i18next.t("common:git.rail.setMinimumWidth", { width }),
              enabled: !isAlreadyMinimum,
              action: onSetMinimum,
            },
            {
              text: i18next.t("common:git.rail.widerWidth", {
                width: nextWider,
              }),
              enabled: nextWider !== width,
              action: () => onWidthChange(nextWider),
            },
            { item: "Separator" },
            miniTerminalVisible
              ? {
                  text: i18next.t("common:git.rail.hideMiniTerminal"),
                  action: onHideMiniTerminal,
                }
              : {
                  text: i18next.t("common:git.rail.openMiniTerminal"),
                  action: onOpenMiniTerminal,
                },
          ];
          return items;
        },
      }).catch((error) => {
        log.error("Failed to show workstation trail menu:", error);
      });
    },
    [
      miniTerminalVisible,
      minWidth,
      onHideMiniTerminal,
      onOpenMiniTerminal,
      onRestoreDefault,
      onSetMinimum,
      onWidthChange,
      width,
    ]
  );
}
