import React from "react";

import { useKeyboardMouseMode } from "@src/hooks/keyboard";

import type { SpotlightItem } from "../types";
import { SpotlightItemRow } from "./SpotlightItemRow";

export interface SpotlightPinnedActionSectionProps {
  items: SpotlightItem[];
  startIndex: number;
  selectedIndex: number;
  onItemSelect: (item: SpotlightItem) => void;
  onItemHover: (index: number) => void;
  searchQuery: string;
  layout?: "list" | "twoColumn";
  /**
   * Minimum rows the two-column grid keeps reserved. Palettes whose pinned
   * actions change with mode (e.g. the worktree palette's switch/remove
   * modes) pass the largest row count so the section — and the panel below
   * it — keeps one height instead of resizing on every mode change.
   */
  reserveRows?: number;
}

export const SpotlightPinnedActionSection: React.FC<
  SpotlightPinnedActionSectionProps
> = ({
  items,
  startIndex,
  selectedIndex,
  onItemSelect,
  onItemHover,
  searchQuery,
  layout = "list",
  reserveRows = 1,
}) => {
  const { isKeyboardMode, handleMouseMove, dataKeyboardMode } =
    useKeyboardMouseMode();

  if (items.length === 0) return null;

  /** Column-major grid: reserve a second row only once the first one is full,
   *  otherwise a single pinned action (e.g. manage mode's "Done") leaves an
   *  equal-height empty track underneath it. `reserveRows` overrides that for
   *  palettes that would rather keep a constant height across modes. */
  const needsSecondRow = items.length > 2 || reserveRows > 1;
  const layoutClassName =
    layout === "twoColumn"
      ? `grid grid-flow-col grid-cols-2 gap-x-2 gap-y-0 ${
          needsSecondRow ? "grid-rows-2" : "grid-rows-1"
        }`
      : "flex flex-col";

  return (
    <div
      className={`border-t border-border-2 py-1 ${layoutClassName}`}
      onMouseMove={handleMouseMove}
      data-keyboard-mode={dataKeyboardMode}
    >
      {items.map((item, localIndex) => {
        const index = startIndex + localIndex;
        return (
          <SpotlightItemRow
            key={item.id}
            item={item}
            selectionState={item.data?.selectionState}
            index={index}
            isSelected={selectedIndex === index}
            isKeyboardMode={isKeyboardMode}
            onSelect={onItemSelect}
            onHover={onItemHover}
            searchQuery={searchQuery}
          />
        );
      })}
    </div>
  );
};

export default SpotlightPinnedActionSection;
