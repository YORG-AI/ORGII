import React, { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import {
  type ModelReasoningLevel,
  formatReasoningLevel,
} from "@src/util/modelVariants";

const THUMB_INSET_PX = 16;
const THUMB_SIZE_PX = 20;

interface EffortSliderProps {
  levels: readonly ModelReasoningLevel[];
  value: ModelReasoningLevel | undefined;
  onChange: (level: ModelReasoningLevel) => void;
}

function indexToLeftStyle(
  index: number,
  maxIndex: number
): React.CSSProperties {
  if (maxIndex <= 0) {
    return { left: "50%" };
  }
  const ratio = index / maxIndex;
  return {
    left: `calc(${THUMB_INSET_PX}px + (100% - ${THUMB_INSET_PX * 2}px) * ${ratio})`,
  };
}

function indexToFillWidth(index: number, maxIndex: number): string {
  if (maxIndex <= 0) {
    return "50%";
  }
  const ratio = index / maxIndex;
  return `calc(${THUMB_INSET_PX}px + (100% - ${THUMB_INSET_PX * 2}px) * ${ratio})`;
}

export const EffortSlider: React.FC<EffortSliderProps> = ({
  levels,
  value,
  onChange,
}) => {
  const { t } = useTranslation();
  const railRef = useRef<HTMLDivElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const selectedIndex = levels.findIndex((level) => level === value);
  const safeSelectedIndex = selectedIndex === -1 ? 0 : selectedIndex;
  const maxIndex = Math.max(0, levels.length - 1);
  const selectedLevel = levels[safeSelectedIndex];
  const thumbStyle = indexToLeftStyle(safeSelectedIndex, maxIndex);
  const fillWidth = indexToFillWidth(safeSelectedIndex, maxIndex);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  const applyIndex = useCallback(
    (nextIndex: number) => {
      const clampedIndex = Math.max(0, Math.min(maxIndex, nextIndex));
      const nextLevel = levels[clampedIndex];
      if (nextLevel) {
        onChange(nextLevel);
      }
    },
    [levels, maxIndex, onChange]
  );

  const getIndexFromClientX = useCallback(
    (clientX: number): number => {
      const rail = railRef.current;
      if (!rail) return safeSelectedIndex;
      const rect = rail.getBoundingClientRect();
      const usableWidth = rect.width - THUMB_INSET_PX * 2;
      if (usableWidth <= 0) return safeSelectedIndex;
      const offset = clientX - rect.left - THUMB_INSET_PX;
      const ratio = Math.max(0, Math.min(1, offset / usableWidth));
      return Math.round(ratio * maxIndex);
    },
    [maxIndex, safeSelectedIndex]
  );

  const beginDrag = useCallback(
    (clientX: number) => {
      applyIndex(getIndexFromClientX(clientX));

      const handleMove = (event: MouseEvent | TouchEvent) => {
        const nextClientX =
          "touches" in event
            ? (event.touches[0]?.clientX ?? clientX)
            : event.clientX;
        applyIndex(getIndexFromClientX(nextClientX));
      };

      const handleUp = () => {
        document.removeEventListener("mousemove", handleMove);
        document.removeEventListener("mouseup", handleUp);
        document.removeEventListener("touchmove", handleMove);
        document.removeEventListener("touchend", handleUp);
      };

      document.addEventListener("mousemove", handleMove);
      document.addEventListener("mouseup", handleUp);
      document.addEventListener("touchmove", handleMove, { passive: true });
      document.addEventListener("touchend", handleUp);

      dragCleanupRef.current = () => {
        document.removeEventListener("mousemove", handleMove);
        document.removeEventListener("mouseup", handleUp);
        document.removeEventListener("touchmove", handleMove);
        document.removeEventListener("touchend", handleUp);
      };
    },
    [applyIndex, getIndexFromClientX]
  );

  const handleRailPointerDown = (
    event: React.MouseEvent | React.TouchEvent
  ) => {
    event.preventDefault();
    const nativeEvent = event.nativeEvent as MouseEvent | TouchEvent;
    const clientX =
      "touches" in nativeEvent
        ? (nativeEvent.touches[0]?.clientX ?? 0)
        : nativeEvent.clientX;
    beginDrag(clientX);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      applyIndex(safeSelectedIndex - 1);
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      applyIndex(safeSelectedIndex + 1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      applyIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      applyIndex(maxIndex);
    }
  };

  if (levels.length === 0) {
    return null;
  }

  return (
    <div className="px-1.5 py-2.5">
      <div className="mb-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-text-3">
          {t("selectors.modelProperties.effort", {
            defaultValue: "Effort",
          })}
        </div>
        <div className="pt-3 text-[13px] font-medium text-primary-6">
          {selectedLevel ? formatReasoningLevel(selectedLevel) : "—"}
        </div>
      </div>

      {levels.length > 1 ? (
        <>
          <div
            ref={railRef}
            className="relative h-7 cursor-pointer overflow-hidden rounded-full bg-fill-2"
            onMouseDown={handleRailPointerDown}
            onTouchStart={handleRailPointerDown}
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-fill-3 transition-[width] duration-150 ease-out"
              style={{ width: fillWidth }}
              aria-hidden="true"
            />
            <div
              className="pointer-events-none absolute inset-y-0 left-4 right-4 flex items-center justify-between"
              aria-hidden="true"
            >
              {levels.map((level, index) => {
                const isPassed = index < safeSelectedIndex;
                const isLast = index === maxIndex;
                const dotColor = isLast
                  ? "bg-text-1"
                  : isPassed
                    ? "bg-primary-6"
                    : "bg-text-2";
                return (
                  <span
                    key={level}
                    className={`h-1 w-1 rounded-full ${dotColor}`}
                  />
                );
              })}
            </div>
            <button
              type="button"
              role="slider"
              aria-valuemin={0}
              aria-valuemax={maxIndex}
              aria-valuenow={safeSelectedIndex}
              aria-valuetext={
                selectedLevel ? formatReasoningLevel(selectedLevel) : undefined
              }
              aria-label={t("selectors.modelProperties.effort", {
                defaultValue: "Effort",
              })}
              tabIndex={0}
              className="absolute top-1/2 z-[1] -translate-x-1/2 -translate-y-1/2 rounded-full border border-border-2 bg-bg-2 shadow-[0_1px_2px_rgba(0,0,0,0.08)] transition-[left] duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-6"
              style={{
                ...thumbStyle,
                width: THUMB_SIZE_PX,
                height: THUMB_SIZE_PX,
              }}
              onMouseDown={(event) => {
                event.stopPropagation();
                event.preventDefault();
                beginDrag(event.clientX);
              }}
              onTouchStart={(event) => {
                event.stopPropagation();
                event.preventDefault();
                const touch = event.touches[0];
                if (touch) {
                  beginDrag(touch.clientX);
                }
              }}
              onKeyDown={handleKeyDown}
            />
          </div>
          <div className="mt-4 flex w-full items-center justify-between text-[11px] text-text-2">
            <span>
              {t("selectors.modelProperties.faster", {
                defaultValue: "Faster",
              })}
            </span>
            <span>
              {t("selectors.modelProperties.smarter", {
                defaultValue: "Smarter",
              })}
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
};

export default EffortSlider;
