/**
 * SpotlightPillBar
 *
 * Pill-only header row — no text input. Used by palettes that embed their
 * own content (e.g. SessionCreatorPalette) and only need the back-chevron
 * pill for navigation context.
 */
import React from "react";

import { ArrowLeft01Icon, HugeiconsIcon } from "@src/icons";

import { SPOTLIGHT_CLASSES, SPOTLIGHT_TOKENS } from "../constants";
import type { PathSegment } from "../types";

interface SpotlightPillBarProps {
  path: PathSegment[];
  onRemoveSegment?: (index: number) => void;
  trailingSlot?: React.ReactNode;
}

export const SpotlightPillBar: React.FC<SpotlightPillBarProps> = ({
  path,
  onRemoveSegment,
  trailingSlot,
}) => {
  const handlePillRemove = (
    index: number,
    event?: React.MouseEvent<HTMLElement>
  ) => {
    event?.preventDefault();
    event?.stopPropagation();
    onRemoveSegment?.(index);
  };

  if (path.length === 0) return null;

  return (
    <div className="flex h-[56px] min-h-[56px] items-center gap-2 px-4">
      <div
        className={`flex min-w-0 flex-shrink-0 items-center gap-2 ${SPOTLIGHT_TOKENS.inputFontSize} text-text-1`}
      >
        {path.map((segment, index) => {
          const canRemove = !!onRemoveSegment;
          return (
            <div
              key={`${segment.type}-${segment.id}`}
              className={`${SPOTLIGHT_CLASSES.primaryPill} ${canRemove ? "cursor-pointer" : ""}`}
              onClick={
                canRemove
                  ? (event) => handlePillRemove(index, event)
                  : undefined
              }
              title={segment.label}
            >
              {canRemove && (
                <HugeiconsIcon
                  icon={ArrowLeft01Icon}
                  data-icon="chevron-left"
                  size={13}
                  strokeWidth={2.5}
                  className="shrink-0"
                />
              )}
              <span
                className={`max-w-[220px] truncate ${SPOTLIGHT_TOKENS.inputFontSize}`}
              >
                {segment.label}
              </span>
            </div>
          );
        })}
      </div>

      {trailingSlot && (
        <div className="flex flex-shrink-0 items-center">{trailingSlot}</div>
      )}
    </div>
  );
};

export default SpotlightPillBar;
