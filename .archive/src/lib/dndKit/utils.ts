/**
 * dnd-kit WebView-Aware Utilities
 *
 * Custom sensors and modifiers to handle coordinate issues in
 * WebView environments (Tauri, WKWebView, etc.) with CSS zoom/scale.
 */
import type { Modifier } from "@dnd-kit/core";
import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";

/**
 * Get the UI scale factor from CSS variable
 * UIScaleProvider sets --ui-scale on documentElement
 */
export function getUiScaleFromCssVar(): number {
  if (typeof document === "undefined") return 1;

  const rawScale = getComputedStyle(document.documentElement)
    .getPropertyValue("--ui-scale")
    .trim();
  const parsedScale = Number(rawScale);

  if (!Number.isFinite(parsedScale) || parsedScale <= 0) return 1;
  return parsedScale;
}

/**
 * Custom modifier that adjusts transform coordinates for UI scale
 *
 * In WebView environments with CSS zoom, the pointer coordinates
 * are in screen space but transforms need to be in scaled space.
 * This modifier corrects for that discrepancy.
 */
export const scaleAwareModifier: Modifier = ({ transform }) => {
  const uiScale = getUiScaleFromCssVar();

  if (uiScale === 1) return transform;

  return {
    ...transform,
    x: transform.x / uiScale,
    y: transform.y / uiScale,
  };
};

/**
 * Configuration options for WebView sensors
 */
export interface WebViewSensorOptions {
  /**
   * Distance in pixels before drag starts (default: 8)
   * Higher values prevent accidental drags
   */
  activationDistance?: number;
  /**
   * Delay in ms before drag starts (default: 0)
   * Useful for touch devices to distinguish scrolling from dragging
   */
  activationDelay?: number;
  /**
   * Enable keyboard sensor for accessibility (default: true)
   */
  enableKeyboard?: boolean;
  /**
   * Tolerance for the activation constraint (default: 5)
   */
  activationTolerance?: number;
}

/**
 * Hook that returns WebView-aware sensors for dnd-kit
 *
 * @example
 * ```tsx
 * const sensors = useWebViewSensors();
 *
 * return (
 *   <DndContext sensors={sensors} modifiers={[scaleAwareModifier]}>
 *     ...
 *   </DndContext>
 * );
 * ```
 */
export function useWebViewSensors(options: WebViewSensorOptions = {}) {
  const {
    activationDistance = 8,
    activationDelay = 0,
    enableKeyboard = true,
    activationTolerance = 5,
  } = options;

  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: {
      distance: activationDistance,
      delay: activationDelay,
      tolerance: activationTolerance,
    },
  });

  const keyboardSensor = useSensor(KeyboardSensor, {
    coordinateGetter: sortableKeyboardCoordinates,
  });

  const sensorsWithKeyboard = useSensors(pointerSensor, keyboardSensor);
  const sensorsWithoutKeyboard = useSensors(pointerSensor);

  return enableKeyboard ? sensorsWithKeyboard : sensorsWithoutKeyboard;
}
