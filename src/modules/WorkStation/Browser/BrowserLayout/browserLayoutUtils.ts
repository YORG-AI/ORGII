/**
 * Pure helper functions for BrowserLayout state derivation.
 * Extracted from useBrowserLayoutState to keep that file under the hook
 * line limit.
 */
import type { ElementInfo } from "../hooks/useWebviewInspector";

/**
 * Short, pill-friendly label for a selected DOM element
 * (e.g. `div.hp_trivia_outer`).
 */
export function buildSelectedElementLabel(element: ElementInfo): string {
  const selector = element.selector || element.tagName || "element";
  return selector.length > 48 ? `${selector.slice(0, 45)}...` : selector;
}
