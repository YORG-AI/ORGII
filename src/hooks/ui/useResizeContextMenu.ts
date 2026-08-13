/**
 * useResizeContextMenu Hook
 *
 * Provides a native OS context menu for resize handles with:
 * - "Resize to default width/height (Xpx)" — resets to the configured default
 * - "Minimize width/height (Xpx)" — shrinks to the minimum allowed size
 *
 * Used by:
 * - WorkStationShell (primary sidebar, right panel, bottom panel)
 * - ResizableSplitPanel (Code Editor sidebar)
 * - EditorBottomPanel (bottom panel height)
 */
import i18next from "i18next";
import { type MouseEvent, useCallback } from "react";

import { createLogger } from "@src/hooks/logger";
import {
  type NativeMenuItemOptions,
  popupNativeMenu,
} from "@src/util/platform/tauri/nativeMenuPopup";

const log = createLogger("useResizeContextMenu");

export interface ResizeContextMenuPositionAction {
  target: "left" | "right";
  onSelect: () => void;
}

export interface UseResizeContextMenuOptions {
  /** "width" for horizontal resize (left/right panels), "height" for vertical (bottom panel) */
  dimension: "width" | "height";
  /** Current size in pixels */
  currentSize: number;
  /** Size to reset to when "Resize to default" is selected */
  defaultSize: number;
  /** Minimum size (for "Minimize" option) */
  minSize: number;
  /** Callback to apply the new size */
  onSizeChange: (size: number) => void;
  /** Optional left/right placement action shown after resize commands */
  positionAction?: ResizeContextMenuPositionAction;
  /** Callback when user selects "Close panel" — shows a separator + close item when provided */
  onClose?: () => void;
}

const TOOLTIP_KEYS = {
  width: {
    resizeToDefault: "tooltips.resizeToDefault",
    minimize: "tooltips.minimizeWidth",
  },
  height: {
    resizeToDefault: "tooltips.resizeToDefaultHeight",
    minimize: "tooltips.minimizeHeight",
  },
} as const;

export function useResizeContextMenu({
  dimension,
  currentSize,
  defaultSize,
  minSize,
  onSizeChange,
  positionAction,
  onClose,
}: UseResizeContextMenuOptions) {
  const handleContextMenu = useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const isAlreadyDefault = currentSize === defaultSize;
      const isAlreadyMin = currentSize <= minSize;
      const keys = TOOLTIP_KEYS[dimension];
      const interpolate =
        dimension === "width"
          ? { width: defaultSize }
          : { height: defaultSize };
      const interpolateMin =
        dimension === "width" ? { width: minSize } : { height: minSize };

      void popupNativeMenu({
        source: "resize-handle",
        buildItems: () => {
          const items: NativeMenuItemOptions[] = [
            {
              text: i18next.t(keys.resizeToDefault, interpolate),
              enabled: !isAlreadyDefault,
              action: () => {
                onSizeChange(defaultSize);
              },
            },
            {
              text: i18next.t(keys.minimize, interpolateMin),
              enabled: !isAlreadyMin,
              action: () => {
                onSizeChange(minSize);
              },
            },
          ];

          if (positionAction) {
            items.push(
              { item: "Separator" },
              {
                text: i18next.t(
                  positionAction.target === "left"
                    ? "spotlightActions.moveWorkstationSidebarLeft"
                    : "spotlightActions.moveWorkstationSidebarRight"
                ),
                action: positionAction.onSelect,
              }
            );
          }

          if (onClose) {
            items.push(
              { item: "Separator" },
              {
                text: i18next.t("tooltips.closePanel"),
                action: () => {
                  onClose();
                },
              }
            );
          }

          return items;
        },
      }).catch((error) => {
        log.error("Failed to show resize context menu:", error);
      });
    },
    [
      dimension,
      currentSize,
      defaultSize,
      minSize,
      onSizeChange,
      positionAction,
      onClose,
    ]
  );

  return handleContextMenu;
}
