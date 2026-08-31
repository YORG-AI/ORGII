import React, { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import {
  type ModelReasoningLevel,
  formatReasoningLevel,
} from "@src/util/modelVariants";

import "./EffortSlider.scss";

const COMET_INDICES = Array.from({ length: 18 }, (_, index) => index);

interface EffortSliderProps {
  levels: readonly ModelReasoningLevel[];
  value: ModelReasoningLevel | undefined;
  onChange: (level: ModelReasoningLevel) => void;
  fast?: boolean;
  animate?: boolean;
}

export const EffortSlider: React.FC<EffortSliderProps> = ({
  levels,
  value,
  onChange,
  fast = false,
  animate = true,
}) => {
  const { t } = useTranslation();
  const sliderRef = useRef<HTMLDivElement>(null);
  const selectedIndex = Math.max(
    0,
    levels.findIndex((level) => level === value)
  );
  const maxIndex = Math.max(0, levels.length - 1);
  const selectedLevel = levels[selectedIndex];
  const hasRange = levels.length > 1;

  useEffect(() => {
    const slider = sliderRef.current;
    if (!slider || !hasRange || !animate) return;

    // CSS owns the motion; this popover-scoped listener only gates it when
    // the document hides. No animation frames, timers, or particle buffers.
    const syncVisibility = () => {
      slider.dataset.motion =
        document.visibilityState === "hidden" ? "paused" : "running";
    };
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
      slider.dataset.motion = "paused";
    };
  }, [animate, hasRange]);

  if (!selectedLevel) return null;

  const levelLabel = formatReasoningLevel(selectedLevel);
  const effortLabel = t("selectors.modelProperties.effort", {
    defaultValue: "Effort",
  });

  return (
    <div className="px-1.5 py-1">
      <div className="mb-1 flex items-center justify-between gap-3 text-xs leading-4">
        <span className="font-medium text-text-3">{effortLabel}</span>
        <span className="font-medium text-primary-6">{levelLabel}</span>
      </div>
      {hasRange && (
        <div
          ref={sliderRef}
          className="effort-slider"
          data-fast={fast}
          style={
            {
              "--effort-progress": selectedIndex / maxIndex,
            } as React.CSSProperties
          }
        >
          <div className="effort-slider__rail bg-fill-2" aria-hidden="true">
            <div className="effort-slider__fill bg-primary-6">
              {COMET_INDICES.map((index) => (
                <span key={index} className="effort-slider__comet" />
              ))}
            </div>
            <div className="effort-slider__stages">
              {levels.map((level, index) => (
                <span
                  key={level}
                  className={`h-1 w-1 rounded-full ${index < selectedIndex ? "bg-white/80" : "bg-text-3"}`}
                />
              ))}
            </div>
          </div>
          <input
            className="effort-slider__input"
            type="range"
            min={0}
            max={maxIndex}
            step={1}
            value={selectedIndex}
            aria-label={effortLabel}
            aria-valuetext={levelLabel}
            onChange={(event) => {
              const nextLevel = levels[event.currentTarget.valueAsNumber];
              if (nextLevel && nextLevel !== selectedLevel) onChange(nextLevel);
            }}
          />
          <span
            className="effort-slider__thumb bg-white shadow-dropdown-soft"
            aria-hidden="true"
          />
        </div>
      )}
    </div>
  );
};

export default EffortSlider;
