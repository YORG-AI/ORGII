/**
 * Event Context Configuration
 *
 * Pure rendering metadata keyed by Rust's `ui_canonical` — no React, no
 * dynamic imports. Kept separate from `./index.ts` (which owns the lazy
 * `COMPONENT_LOADERS`) so non-UI consumers such as the chat-projection web
 * worker can read chat/simulator config without pulling every event
 * renderer's `import()` edge into their bundle graph.
 */
import { getCliUiCanonical } from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import type {
  ChatContextConfig,
  SimulatorContextConfig,
} from "@src/engines/SessionCore/rendering/registry/types";

// ============================================
// Context Configuration by ui_canonical
// Metadata for rendering behavior (not loaders)
// ============================================

export interface ContextConfig {
  chat?: ChatContextConfig;
  simulator?: SimulatorContextConfig;
}

export const CONTEXT_CONFIG: Record<string, ContextConfig> = {
  // File operations
  read_file: {
    chat: { requiresItemIndex: false, showStatusLine: true },
    simulator: {
      supportsSplitView: false,
      supportsFullscreen: true,
      supportsAutoScroll: true,
    },
  },
  edit_file: {
    chat: { requiresItemIndex: false, showStatusLine: true },
    simulator: {
      supportsSplitView: true,
      supportsFullscreen: true,
      supportsTypewriter: true,
    },
  },
  delete_file: {
    chat: { requiresItemIndex: false, showStatusLine: true },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  list_dir: {
    chat: { requiresItemIndex: false, showStatusLine: true },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  tool_search: {
    chat: { requiresItemIndex: false, showStatusLine: true },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Terminal
  run_shell: {
    chat: { requiresItemIndex: false, showStatusLine: false },
    simulator: { supportsSplitView: true, supportsFullscreen: true },
  },

  // Await output (background task monitor)
  await_output: {
    chat: { requiresItemIndex: false, showStatusLine: true },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  inspect_terminals: {
    chat: { requiresItemIndex: false, showStatusLine: true },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Search
  code_search: {
    chat: { requiresItemIndex: false, showStatusLine: true },
    simulator: { supportsSplitView: false, supportsFullscreen: true },
  },
  web_search: {
    chat: { requiresItemIndex: false, showStatusLine: true },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  glob_file_search: {
    chat: { requiresItemIndex: false, showStatusLine: true },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Conversation
  agent_message: {
    chat: { requiresItemIndex: true, showStatusLine: true },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  thinking: {
    chat: { requiresItemIndex: false, showStatusLine: false },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  user: {
    chat: { requiresItemIndex: false, showStatusLine: true },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  ask_user_questions: {
    chat: { requiresItemIndex: false, showStatusLine: true },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  org_send_message: {
    chat: { requiresItemIndex: false, showStatusLine: true },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  // Approval
  ask_user_permissions: {
    chat: { requiresItemIndex: false, showStatusLine: true },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Subagent / Task
  subagent: {
    chat: { requiresItemIndex: false, showStatusLine: false },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  suggest_mode_switch: {
    chat: { requiresItemIndex: false, showStatusLine: false },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  manage_todo: {
    chat: { requiresItemIndex: false, showStatusLine: false },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  task_create: {
    chat: { requiresItemIndex: false, showStatusLine: false },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  task_update: {
    chat: { requiresItemIndex: false, showStatusLine: false },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  task_list: {
    chat: { requiresItemIndex: false, showStatusLine: false },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  task_get: {
    chat: { requiresItemIndex: false, showStatusLine: false },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Browser
  browser: {
    chat: { requiresItemIndex: false, showStatusLine: true },
    simulator: { supportsSplitView: false, supportsFullscreen: true },
  },
  internal_browser: {
    chat: { requiresItemIndex: false, showStatusLine: true },
    simulator: { supportsSplitView: false, supportsFullscreen: true },
  },

  // MCP server tools
  mcp_tool: {
    chat: { requiresItemIndex: false, showStatusLine: true },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Turn summary
  turn_summary: {
    chat: { requiresItemIndex: false, showStatusLine: false },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Rate limit hint
  rate_limit_hint: {
    chat: { requiresItemIndex: false, showStatusLine: false },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Compact boundary (context compacted marker)
  context_compacted: {
    chat: { requiresItemIndex: false, showStatusLine: false },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Worktree
  worktree: {
    chat: { requiresItemIndex: false, showStatusLine: true },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Setup repo
  setup_repo: {
    chat: { requiresItemIndex: false, showStatusLine: false },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Canvas card
  canvas_inline: {
    chat: { requiresItemIndex: false, showStatusLine: false },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Plan card
  plan_approval: {
    chat: { requiresItemIndex: false, showStatusLine: false },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Generic fallback
  tool_call: {
    chat: { requiresItemIndex: false, showStatusLine: true },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
};

// ============================================
// Chat Context Helpers
// ============================================

/**
 * Get chat context config for an event type.
 */
export function getChatContextConfig(eventType: string): {
  requiresItemIndex?: boolean;
  showStatusLine?: boolean;
} | null {
  const uiCanonical = getCliUiCanonical(eventType);
  return CONTEXT_CONFIG[uiCanonical]?.chat ?? null;
}

/**
 * Check if an event type should show status line in chat context.
 */
export function chatShowsStatusLine(eventType: string): boolean {
  return getChatContextConfig(eventType)?.showStatusLine ?? true;
}

/**
 * Check if an event type requires itemIndex prop in chat context.
 */
export function chatRequiresItemIndex(eventType: string): boolean {
  return getChatContextConfig(eventType)?.requiresItemIndex ?? false;
}

/**
 * Get action configuration for chat context (alias used by the chat
 * item pipeline / ActionRegistry).
 */
export function getActionConfig(actionType: string): {
  requiresItemIndex?: boolean;
  showStatusLine?: boolean;
} | null {
  return getChatContextConfig(actionType);
}

/**
 * Check if action_type should show status line in chat
 */
export function shouldShowStatusLine(actionType: string): boolean {
  const config = getActionConfig(actionType);
  return config?.showStatusLine ?? true;
}

/**
 * Check if component requires itemIndex prop
 */
export function requiresItemIndex(actionType: string): boolean {
  const config = getActionConfig(actionType);
  return config?.requiresItemIndex ?? false;
}
