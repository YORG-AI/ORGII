import { type RefObject, useEffect } from "react";

import type { ComposerInputRef } from "@src/components/ComposerInput";
import type { TabDragEventDetail } from "@src/modules/WorkStation/shared/TabBar/tabDragTypes";

import {
  insertPillFromTabPayload,
  insertTabAsPill,
  isPointerOverDropTarget,
} from "./dropTargetUtils";

export function useTabDragEndToPill(
  containerRef: RefObject<HTMLElement | null>,
  composerInputRef: RefObject<ComposerInputRef | null>,
  /** False on composers that must refuse dragged references entirely. */
  enabled = true
): void {
  useEffect(() => {
    if (!enabled) return undefined;

    const handleTabDragEnd = (e: Event) => {
      const event = e as CustomEvent<TabDragEventDetail>;
      const { filePath, name, type, pill, pointerX, pointerY } = event.detail;
      if (pointerX == null || pointerY == null) return;
      if (!isPointerOverDropTarget(containerRef, pointerX, pointerY)) return;
      if (pill) {
        insertPillFromTabPayload(composerInputRef, {
          ...pill,
          pointerX,
          pointerY,
        });
        return;
      }
      if (!filePath) return;
      insertTabAsPill(composerInputRef, filePath, name, type);
    };

    document.addEventListener("tab-drag-end", handleTabDragEnd);
    return () => {
      document.removeEventListener("tab-drag-end", handleTabDragEnd);
    };
  }, [containerRef, composerInputRef, enabled]);
}
