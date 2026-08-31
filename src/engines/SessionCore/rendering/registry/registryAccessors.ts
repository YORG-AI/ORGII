/**
 * Event Registry Helper Functions
 *
 * Utility functions for working with the event registry
 */
import type { ComponentType, LazyExoticComponent } from "react";

import { type IconSvgElement } from "@src/icons";

import { getAllEventTypes } from "./events";

// Chat-context accessors are pure metadata; re-exported from ./events/contextConfig
// so `ActionRegistry` (and the chat-projection worker behind it) can import
// them without touching the renderer loaders.
export {
  getActionConfig,
  requiresItemIndex,
  shouldShowStatusLine,
} from "./events/contextConfig";

export interface ComponentOption {
  id: string;
  displayName: string;
  icon: IconSvgElement;
  description: string;
  component: LazyExoticComponent<ComponentType<Record<string, unknown>>>;
}
/**
 * Get all registered action types
 */
export function getRegisteredActionTypes(): string[] {
  return getAllEventTypes();
}

/**
 * Prefetch commonly used event components.
 * Uses PRELOAD_COMPONENTS from events/index.ts as single source of truth.
 */
export function prefetchCommonComponents(): void {
  import("./events").then((module) => {
    for (const eventType of module.PRELOAD_COMPONENTS) {
      module.loadEventComponent(eventType).catch(() => {
        // Silently fail - prefetch is optional
      });
    }
  });
}
