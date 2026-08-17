/**
 * Unified Event Registry Types
 *
 * Shared types for the unified event rendering system.
 * Supports multiple contexts: chat, simulator, trajectory
 */
import type { LucideIcon } from "lucide-react";
import type React from "react";

// ============================================
// Component Types
// ============================================

export interface ComponentOption {
  id: string;
  displayName: string;
  icon: LucideIcon;
  description: string;
  component: React.LazyExoticComponent<React.ComponentType<unknown>>;
}

// ============================================
// Context Configuration Types
// ============================================

/** Chat context configuration */
export interface ChatContextConfig {
  /** Requires itemIndex prop for chat history */
  requiresItemIndex?: boolean;
  /** Show status line in chat panel */
  showStatusLine?: boolean;
}

/** Simulator context configuration */
export interface SimulatorContextConfig {
  /** Supports split view mode */
  supportsSplitView?: boolean;
  /** Supports fullscreen mode */
  supportsFullscreen?: boolean;
  /** Supports typewriter animation */
  supportsTypewriter?: boolean;
  /** Supports auto-scroll animation */
  supportsAutoScroll?: boolean;
}

// ============================================
// Component Configuration
// ============================================

/**
 * Component loader function type.
 * Uses `any` for props because event components have specific prop types
 * that are incompatible with `unknown` in contravariant position.
 */
export type ComponentLoader = () => Promise<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: React.ComponentType<any>;
}>;

// ============================================
// Rendering Context Types
// ============================================

/** Rendering context identifier */
export type RenderContext = "chat" | "simulator" | "trajectory";

/** Rendering mode */
export type RenderMode = "interactive" | "simulation";

/**
 * Context accepted by `useUnifiedEventRenderer`.
 *
 * Today the only caller is `useSimulatorAdapter`, which always passes
 * `"simulator"`. Chat goes through `ActivityRouter` → `getChatLazyComponent`,
 * and trajectory rendering uses the normalizer's `variant` field directly
 * — neither flows through this hook. The single-value union keeps the call
 * site explicit and prevents accidental misuse.
 */
export type UnifiedRenderContext = "simulator";

/** Unified render options */
export interface UnifiedRenderOptions {
  /** Current rendering context (currently always "simulator"). */
  context: UnifiedRenderContext;

  /** Rendering mode */
  mode?: RenderMode;

  /** Enable virtualization for large lists */
  enableVirtualization?: boolean;

  /** Cache key for render memoization */
  cacheKey?: string;
}

// ============================================
// CLI Agent Alias Types (from Rust cli_agents/alias_map.rs)
// ============================================

/**
 * AppSubtool values (matches Rust `AppSubtool` enum).
 * Used for fine-grained panel routing within the simulator apps.
 */
export type AppSubtool =
  | "file_read"
  | "file_write"
  | "shell"
  | "explore"
  | "search"
  | "glob"
  | "browser"
  | "internal_browser"
  | "project"
  | "message"
  | "other_interactions"
  | "todo"
  | "subagent"
  | "thinking"
  | "other_tool";

export const APP_SUBTOOL = {
  FILE_READ: "file_read",
  FILE_WRITE: "file_write",
  SHELL: "shell",
  EXPLORE: "explore",
  SEARCH: "search",
  GLOB: "glob",
  BROWSER: "browser",
  INTERNAL_BROWSER: "internal_browser",
  STORY: "project",
  MESSAGE: "message",
  OTHER_INTERACTIONS: "other_interactions",
  TODO: "todo",
  SUBAGENT: "subagent",
  THINKING: "thinking",
  OTHER_TOOL: "other_tool",
} as const satisfies Record<string, AppSubtool>;

export type ToolDisplayBehavior = "instant" | "stream" | "wait_for_result";

export const TOOL_DISPLAY_BEHAVIOR = {
  INSTANT: "instant",
  STREAM: "stream",
  WAIT_FOR_RESULT: "wait_for_result",
} as const satisfies Record<string, ToolDisplayBehavior>;

/**
 * ChatBlock values (matches Rust `ChatBlock` enum).
 *
 * One variant per actual React block component in
 * `src/engines/ChatPanel/blocks/`. Independent from `AppSubtool`, which is
 * the simulator's tab taxonomy — the chat panel does not need the simulator
 * grouping, so it has its own smaller dispatch enum with no dead branches.
 */
export type ChatBlock =
  | "read_file"
  | "diff"
  | "shell"
  | "explore"
  | "search"
  | "glob"
  | "web_search"
  | "todo"
  | "org_task"
  | "subagent"
  | "title_only"
  | "sent_message"
  | "plan_doc"
  | "hidden"
  | "canvas_inline"
  | "setup_repo"
  | "fallback";

/**
 * Canonical entry with storage, UI, simulator app, appSubtool, and chatBlock mapping.
 * - storage: Fine-grained name for DB storage (e.g., "edit_file_by_replace")
 * - ui: Coarse name for UI component lookup (e.g., "edit_file")
 * - simulatorApp: Dock routing ("CODE_EDITOR", "BROWSER", "CHANNELS", "STORY_MANAGER")
 * - appSubtool: Panel routing within a simulator app ("file_read", "shell", "explore", etc.)
 * - chatBlock: Chat-panel block dispatch key ("read_file", "diff", "shell", "fallback", ...)
 */
export interface AliasEntry {
  storage: string;
  ui: string;
  simulatorApp: string;
  appSubtool: AppSubtool;
  chatBlock: ChatBlock;
}
