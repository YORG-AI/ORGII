import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  MODEL_REASONING_LEVEL,
  type ModelReasoningLevel,
  formatReasoningLevel,
} from "@src/util/modelVariants";

import "./EffortSlider.scss";

const COMET_INDICES = Array.from({ length: 18 }, (_, index) => index);
const RANGE_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

interface EffortSliderProps {
  levels: readonly ModelReasoningLevel[];
  value: ModelReasoningLevel | undefined;
  onChange: (level: ModelReasoningLevel) => void;
  fast?: boolean;
  animate?: boolean;
  showLabel?: boolean;
}

export const EffortSlider: React.FC<EffortSliderProps> = ({
  levels,
  value,
  onChange,
  fast = false,
  animate = true,
  showLabel = true,
}) => {
  const { t } = useTranslation();
  const sliderRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{
    level: ModelReasoningLevel;
    sourceValue: ModelReasoningLevel | undefined;
  }>();
  const interactionRef = useRef<{
    kind: "pointer" | "keyboard";
    pointerId?: number;
    level: ModelReasoningLevel | undefined;
    sourceValue: ModelReasoningLevel | undefined;
  } | null>(null);

  const finishInteraction = (commit: boolean) => {
    const interaction = interactionRef.current;
    if (!interaction) return;
    interactionRef.current = null;
    setPreview(undefined);
    if (
      commit &&
      interaction.sourceValue === value &&
      interaction.level &&
      interaction.level !== value
    ) {
      onChange(interaction.level);
    }
  };

  const selectedIndex = Math.max(
    0,
    levels.findIndex(
      (level) =>
        level ===
        (preview?.sourceValue === value ? (preview?.level ?? value) : value)
    )
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
  const isUltra = selectedLevel === MODEL_REASONING_LEVEL.ULTRA;
  const effortLabel = t("selectors.modelProperties.effort", {
    defaultValue: "Effort",
  });

  return (
    <div className="px-1.5 py-1">
      {showLabel && (
        <div className="mb-1 flex items-center justify-between gap-3 text-xs leading-4">
          <span className="font-medium text-text-3">{effortLabel}</span>
          <span
            className={`font-medium ${isUltra ? "text-purple-6" : "text-primary-6"}`}
          >
            {levelLabel}
          </span>
        </div>
      )}
      {hasRange && (
        <div
          ref={sliderRef}
          className="effort-slider"
          data-fast={fast}
          data-effort={selectedLevel}
          style={
            {
              "--effort-progress": selectedIndex / maxIndex,
            } as React.CSSProperties
          }
        >
          <div className="effort-slider__rail bg-fill-2" aria-hidden="true">
            <div className="effort-slider__fill">
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
              if (!nextLevel || nextLevel === selectedLevel) return;
              if (interactionRef.current) {
                interactionRef.current.level = nextLevel;
                setPreview({
                  level: nextLevel,
                  sourceValue: interactionRef.current.sourceValue,
                });
              } else {
                // Assistive input without pointer/key events still commits.
                onChange(nextLevel);
              }
            }}
            // Keep rapid input local; persist only the completed gesture.
            // Let the native thumb own capture, including outside releases.
            // Capturing on the input prevents WebKit from dragging its thumb.
            onPointerDown={(event) => {
              if (event.button !== 0 || interactionRef.current) return;
              interactionRef.current = {
                kind: "pointer",
                pointerId: event.pointerId,
                level: value,
                sourceValue: value,
              };
            }}
            onPointerUp={(event) => {
              if (interactionRef.current?.pointerId === event.pointerId) {
                finishInteraction(true);
              }
            }}
            onPointerCancel={() => finishInteraction(false)}
            onLostPointerCapture={() => {
              if (interactionRef.current?.kind === "pointer")
                finishInteraction(true);
            }}
            onKeyDown={(event) => {
              if (RANGE_KEYS.has(event.key) && !interactionRef.current) {
                interactionRef.current = {
                  kind: "keyboard",
                  level: value,
                  sourceValue: value,
                };
              }
            }}
            onKeyUp={(event) => {
              if (
                RANGE_KEYS.has(event.key) &&
                interactionRef.current?.kind === "keyboard"
              ) {
                finishInteraction(true);
              }
            }}
            onBlur={() => finishInteraction(true)}
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
