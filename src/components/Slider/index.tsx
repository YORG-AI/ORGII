/**
 * Slider Component
 *
 * Native slider/range control with clean styling.
 *
 * Features:
 * - Single value and range (dual handles)
 * - Marks/steps support
 * - Vertical/horizontal orientation
 * - Tooltip on hover/drag
 * - Min/max values
 * - Disabled state
 * - Touch and mouse support
 * - Keyboard navigation
 *
 * @example
 * ```tsx
 * import Slider from "@src/components/Slider";
 *
 * // Single value
 * <Slider
 *   min={0}
 *   max={100}
 *   defaultValue={50}
 *   onValueChange={(value) => {}}
 * />
 *
 * // Range
 * <Slider
 *   range
 *   min={0}
 *   max={100}
 *   defaultValue={[20, 80]}
 *   onValueChange={(value) => {}}
 * />
 *
 * // With marks
 * <Slider
 *   marks={{ 0: '0°C', 25: '25°C', 50: '50°C', 75: '75°C', 100: '100°C' }}
 * />
 * ```
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";

import "./index.scss";

export interface SliderProps {
  /**
   * Current value (controlled)
   */
  value?: number | [number, number];

  /**
   * Default value (uncontrolled)
   */
  defaultValue?: number | [number, number];

  /**
   * Minimum value
   * @default 0
   */
  min?: number;

  /**
   * Maximum value
   * @default 100
   */
  max?: number;

  /**
   * Step increment
   * @default 1
   */
  step?: number;

  /**
   * Marks to display
   */
  marks?: Record<number, React.ReactNode>;

  /**
   * Range mode (dual handles)
   * @default false
   */
  range?: boolean;

  /**
   * Vertical orientation
   * @default false
   */
  vertical?: boolean;

  /**
   * Disabled state
   */
  disabled?: boolean;

  /**
   * Show tooltip
   * @default true
   */
  showTooltip?: boolean;

  /**
   * Tooltip formatter
   */
  formatTooltip?: (value: number) => string;

  /**
   * Value change callback
   */
  onValueChange?: (value: number | [number, number]) => void;

  /**
   * Value commit callback (on pointer release or keyboard step)
   */
  onValueCommit?: (value: number | [number, number]) => void;

  /**
   * Additional class name
   */
  className?: string;

  /**
   * Additional style
   */
  style?: React.CSSProperties;

  /**
   * Remove default padding
   * @default false
   */
  noPadding?: boolean;

  /**
   * Render the handle(s) with a visible 2px border. Useful when the handle
   * sits on a thin rail against a similarly-colored surface, where the
   * default near-white pill lacks contrast.
   * @default false
   */
  handleBordered?: boolean;
}

const Slider: React.FC<SliderProps> = ({
  value: controlledValue,
  defaultValue,
  min = 0,
  max = 100,
  step = 1,
  marks,
  range = false,
  vertical = false,
  disabled = false,
  showTooltip = true,
  formatTooltip,
  onValueChange,
  onValueCommit,
  className = "",
  style,
  noPadding = false,
  handleBordered = false,
}) => {
  const { isDark } = useCurrentTheme();
  const sliderRef = useRef<HTMLDivElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<number | null>(null);
  const [showTooltipFor, setShowTooltipFor] = useState<number | null>(null);

  // Cleanup drag listeners on unmount
  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  // Initialize value
  const getInitialValue = (): number | [number, number] => {
    if (defaultValue !== undefined) return defaultValue;
    return range ? [min, min] : min;
  };

  const [internalValue, setInternalValue] = useState<number | [number, number]>(
    getInitialValue
  );
  const value = controlledValue !== undefined ? controlledValue : internalValue;

  // Normalize value to array
  const normalizedValue = useMemo((): [number, number] => {
    if (Array.isArray(value)) {
      return value as [number, number];
    }
    return [value, value];
  }, [value]);

  // Refs so document-level drag listeners and keyboard handlers always
  // observe the latest props/state. Without these, the move/up callbacks
  // captured `onValueChange` and `normalizedValue` as of mousedown, leading to
  // stale-closure bugs the moment the parent re-rendered mid-drag.
  const onValueChangeRef = useRef(onValueChange);
  const onValueCommitRef = useRef(onValueCommit);
  const normalizedValueRef = useRef(normalizedValue);
  const controlledValueRef = useRef(controlledValue);
  useEffect(() => {
    onValueChangeRef.current = onValueChange;
    onValueCommitRef.current = onValueCommit;
    normalizedValueRef.current = normalizedValue;
    controlledValueRef.current = controlledValue;
  });

  // Calculate percentage from value
  const valueToPercent = useCallback(
    (val: number): number => {
      return ((val - min) / (max - min)) * 100;
    },
    [min, max]
  );

  // Calculate value from percentage
  const percentToValue = useCallback(
    (percent: number): number => {
      let val = min + (percent / 100) * (max - min);

      // Snap to step
      if (step > 0) {
        val = Math.round(val / step) * step;
      }

      // Clamp to min/max
      return Math.max(min, Math.min(max, val));
    },
    [min, max, step]
  );

  // Get position from mouse/touch event
  const getPositionFromEvent = useCallback(
    (event: MouseEvent | TouchEvent): number => {
      if (!sliderRef.current) return 0;

      const rect = sliderRef.current.getBoundingClientRect();
      let clientPos: number;

      if ("touches" in event) {
        clientPos = vertical
          ? event.touches[0].clientY
          : event.touches[0].clientX;
      } else {
        clientPos = vertical ? event.clientY : event.clientX;
      }

      const size = vertical ? rect.height : rect.width;
      const offset = vertical ? rect.bottom - clientPos : clientPos - rect.left;

      return Math.max(0, Math.min(100, (offset / size) * 100));
    },
    [vertical]
  );

  // Apply a new value: writes through the uncontrolled state when applicable
  // and fires the latest `onValueChange` / `onValueCommit` via refs.
  const applyValueChange = useCallback(
    (newValue: number | [number, number], final = false) => {
      if (controlledValueRef.current === undefined) {
        setInternalValue(newValue);
      }
      onValueChangeRef.current?.(newValue);
      if (final) {
        onValueCommitRef.current?.(newValue);
      }
    },
    []
  );

  // Start a drag interaction. `initialPercent` lets the caller seed the
  // drag with a position computed from a track-press (so clicking on the
  // rail starts a drag at the press point, not after the first mousemove).
  const beginDrag = useCallback(
    (handleIndex: number, isTouch: boolean, initialPercent: number | null) => {
      if (disabled) return;

      setDraggingHandle(handleIndex);
      setShowTooltipFor(handleIndex);

      let currentDragValue: number | [number, number] = (() => {
        if (initialPercent == null) return value;
        const seeded = percentToValue(initialPercent);
        if (range) {
          const [v1, v2] = normalizedValueRef.current;
          return handleIndex === 0
            ? ([Math.min(seeded, v2), v2] as [number, number])
            : ([v1, Math.max(seeded, v1)] as [number, number]);
        }
        return seeded;
      })();

      if (initialPercent != null) {
        applyValueChange(currentDragValue);
      }

      const handleMove = (moveEvent: MouseEvent | TouchEvent) => {
        const percent = getPositionFromEvent(moveEvent);
        const newVal = percentToValue(percent);
        if (range) {
          // Read the OTHER handle's value from the ref, not a mousedown-time
          // snapshot, so controlled parents that move the sibling handle
          // mid-drag don't see stale clamps.
          const [val1, val2] = normalizedValueRef.current;
          if (handleIndex === 0) {
            currentDragValue = [Math.min(newVal, val2), val2];
          } else {
            currentDragValue = [val1, Math.max(newVal, val1)];
          }
        } else {
          currentDragValue = newVal;
        }
        applyValueChange(currentDragValue);
      };

      const handleUp = () => {
        setDraggingHandle(null);
        setShowTooltipFor(null);
        applyValueChange(currentDragValue, true);

        document.removeEventListener("mousemove", handleMove);
        document.removeEventListener("mouseup", handleUp);
        document.removeEventListener("touchmove", handleMove);
        document.removeEventListener("touchend", handleUp);
      };

      document.addEventListener("mousemove", handleMove);
      document.addEventListener("mouseup", handleUp);
      // `touchmove` must be non-passive so we can `preventDefault` (set by
      // the touch-action: none on the rail; we still register passive false
      // here so any future preventDefault works).
      document.addEventListener("touchmove", handleMove, { passive: false });
      document.addEventListener("touchend", handleUp);

      dragCleanupRef.current = () => {
        document.removeEventListener("mousemove", handleMove);
        document.removeEventListener("mouseup", handleUp);
        document.removeEventListener("touchmove", handleMove);
        document.removeEventListener("touchend", handleUp);
      };
      // Suppress the immediately-following click on the rail; otherwise
      // releasing the drag would re-trigger `handleTrackClick`.
      void isTouch;
    },
    [
      disabled,
      range,
      value,
      percentToValue,
      getPositionFromEvent,
      applyValueChange,
    ]
  );

  // Handle drag start from the handle pill.
  const handleMouseDown = useCallback(
    (e: React.MouseEvent | React.TouchEvent, handleIndex: number) => {
      if (disabled) return;
      e.preventDefault();
      const isTouch = "touches" in e;
      beginDrag(handleIndex, isTouch, null);
    },
    [disabled, beginDrag]
  );

  // Press-anywhere-on-the-rail starts a drag seeded at the press point.
  // Previously this was a click-only seek, so the user had to hit the tiny
  // 14 px handle to scrub — a tap on the rail just snapped without
  // continuing to follow the pointer.
  const handleRailPointerDown = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      if (disabled) return;
      // Don't double-fire when the press lands on the handle itself.
      const target = e.target as HTMLElement | null;
      if (target && target.closest(".slider-handle")) return;

      e.preventDefault();
      const isTouch = "touches" in e;
      const nativeEvent = e.nativeEvent as MouseEvent | TouchEvent;
      const percent = getPositionFromEvent(nativeEvent);

      // Pick the closer handle for range mode; single-handle slider is index 0.
      let handleIndex = 0;
      if (range) {
        const [v1, v2] = normalizedValueRef.current;
        const seeded = percentToValue(percent);
        handleIndex = Math.abs(seeded - v1) <= Math.abs(seeded - v2) ? 0 : 1;
      }
      beginDrag(handleIndex, isTouch, percent);
    },
    [disabled, range, getPositionFromEvent, percentToValue, beginDrag]
  );

  // Keyboard navigation. The handle already advertises this via `role="slider"`
  // + tabIndex, but the previous implementation registered no key handlers,
  // leaving a focusable-but-inoperable control.
  const handleHandleKeyDown = useCallback(
    (e: React.KeyboardEvent, handleIndex: number) => {
      if (disabled) return;
      let delta = 0;
      let absolute: number | null = null;
      const big = Math.max(step, (max - min) / 10);
      switch (e.key) {
        case "ArrowLeft":
        case "ArrowDown":
          delta = -step;
          break;
        case "ArrowRight":
        case "ArrowUp":
          delta = step;
          break;
        case "PageDown":
          delta = -big;
          break;
        case "PageUp":
          delta = big;
          break;
        case "Home":
          absolute = min;
          break;
        case "End":
          absolute = max;
          break;
        default:
          return;
      }
      e.preventDefault();

      const apply = (raw: number) => {
        const clamped = Math.max(min, Math.min(max, raw));
        if (range) {
          const [v1, v2] = normalizedValueRef.current;
          const next: [number, number] =
            handleIndex === 0
              ? [Math.min(clamped, v2), v2]
              : [v1, Math.max(clamped, v1)];
          applyValueChange(next, true);
        } else {
          applyValueChange(clamped, true);
        }
      };

      if (absolute !== null) {
        apply(absolute);
        return;
      }
      const current = range
        ? normalizedValueRef.current[handleIndex]
        : normalizedValueRef.current[0];
      apply(current + delta);
    },
    [disabled, step, min, max, range, applyValueChange]
  );

  const sliderClasses = [
    "slider",
    vertical && "slider-vertical",
    disabled && "slider-disabled",
    draggingHandle !== null && "slider-dragging",
    isDark && "slider-dark",
    noPadding && "slider-no-padding",
    handleBordered && "slider-handle-bordered",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const renderHandle = (handleValue: number, handleIndex: number) => {
    const percent = valueToPercent(handleValue);
    const positionStyle = vertical
      ? { bottom: `${percent}%` }
      : { left: `${percent}%` };

    const showTooltipNow =
      showTooltip &&
      (draggingHandle === handleIndex || showTooltipFor === handleIndex);

    return (
      <div
        key={handleIndex}
        className="slider-handle"
        style={positionStyle}
        onMouseDown={(event) => handleMouseDown(event, handleIndex)}
        onTouchStart={(event) => handleMouseDown(event, handleIndex)}
        onKeyDown={(event) => handleHandleKeyDown(event, handleIndex)}
        onMouseEnter={() => setShowTooltipFor(handleIndex)}
        onMouseLeave={() => setShowTooltipFor(null)}
        role="slider"
        aria-valuenow={handleValue}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
      >
        {showTooltipNow && (
          <div className="slider-tooltip">
            {formatTooltip ? formatTooltip(handleValue) : handleValue}
          </div>
        )}
      </div>
    );
  };

  const renderTrack = () => {
    if (range) {
      const [val1, val2] = normalizedValue;
      const percent1 = valueToPercent(val1);
      const percent2 = valueToPercent(val2);

      const trackStyle = vertical
        ? { bottom: `${percent1}%`, height: `${percent2 - percent1}%` }
        : { left: `${percent1}%`, width: `${percent2 - percent1}%` };

      return <div className="slider-track" style={trackStyle} />;
    } else {
      const percent = valueToPercent(normalizedValue[0]);
      const trackStyle = vertical
        ? { bottom: 0, height: `${percent}%` }
        : { left: 0, width: `${percent}%` };

      return <div className="slider-track" style={trackStyle} />;
    }
  };

  const renderMarks = () => {
    if (!marks) return null;

    return (
      <div className="slider-marks">
        {Object.entries(marks).map(([markValue, markLabel]) => {
          const val = Number(markValue);
          const percent = valueToPercent(val);
          const positionStyle = vertical
            ? { bottom: `${percent}%` }
            : { left: `${percent}%` };

          return (
            <div key={val} className="slider-mark" style={positionStyle}>
              <div className="slider-mark-dot" />
              <div className="slider-mark-label">{markLabel}</div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className={sliderClasses} style={style}>
      <div
        ref={sliderRef}
        className="slider-rail"
        onMouseDown={handleRailPointerDown}
        onTouchStart={handleRailPointerDown}
      >
        {renderTrack()}
        {range ? (
          <>
            {renderHandle(normalizedValue[0], 0)}
            {renderHandle(normalizedValue[1], 1)}
          </>
        ) : (
          renderHandle(normalizedValue[0], 0)
        )}
        {renderMarks()}
      </div>
    </div>
  );
};

export default Slider;
