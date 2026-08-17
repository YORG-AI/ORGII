/**
 * Event Registry Helper Functions
 *
 * Utility functions for working with the event registry
 */
import {
  Brain,
  HelpCircle,
  type LucideIcon,
  MessageSquare,
  User,
} from "lucide-react";
import type { ComponentType, LazyExoticComponent } from "react";

import { getToolIconComponent } from "@src/config/toolIcons";
import { resolveToolName } from "@src/engines/SessionCore/rendering/registry/toolAliases";

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
  icon: LucideIcon;
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

// ============================================
// Trajectory timeline icons (aligned with chat)
// ============================================

/**
 * Conversation / lifecycle rows — match SessionCore chat blocks.
 * Agent replies use `MessageSquare` like `AgentMessageBlock`; tools use Rust-backed icons below.
 */
const TRAJECTORY_CHAT_ALIGNED_ICON: Record<string, LucideIcon> = {
  message: MessageSquare,
  /** User prompts — same `MessageSquare` as assistant `message` rows (chat-aligned) */
  user_message: MessageSquare,
  /** Fallback if functionName is still `user_input` before grouping */
  user_input: MessageSquare,
  thinking: Brain,
  ask_user_questions: HelpCircle,
  raw_event: User,
};

/**
 * Lucide icon for a trajectory row: same rules as chat `ToolCallBlock` / `getToolIconComponent`
 * (Rust `list_all_tools` icon ids + `TOOL_ICON_COMPONENTS` fallbacks). Pass the group's
 * representative `functionName` (first event) so grouped `command` / `search` resolve correctly.
 */
export function getTrajectoryTimelineIcon(
  groupType: string,
  toolNameForRust?: string
): LucideIcon {
  const chatAligned = TRAJECTORY_CHAT_ALIGNED_ICON[groupType];
  if (chatAligned) {
    return chatAligned;
  }

  const nameForTool =
    toolNameForRust && toolNameForRust.length > 0 ? toolNameForRust : groupType;
  return getToolIconComponent(resolveToolName(nameForTool));
}
