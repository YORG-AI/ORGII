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
    chat: {},
    simulator: {
      supportsSplitView: false,
      supportsFullscreen: true,
      supportsAutoScroll: true,
    },
  },
  edit_file: {
    chat: {},
    simulator: {
      supportsSplitView: true,
      supportsFullscreen: true,
      supportsTypewriter: true,
    },
  },
  delete_file: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  list_dir: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  tool_search: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Terminal
  run_shell: {
    chat: {},
    simulator: { supportsSplitView: true, supportsFullscreen: true },
  },

  // Await output (background task monitor)
  await_output: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  inspect_terminals: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Search
  code_search: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: true },
  },
  web_search: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  glob_file_search: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Conversation
  agent_message: {
    chat: { requiresItemIndex: true },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  thinking: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  user: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  ask_user_questions: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  org_send_message: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  // Approval
  ask_user_permissions: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Subagent / Task
  subagent: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  suggest_mode_switch: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  manage_todo: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  task_create: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  task_update: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  task_list: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
  task_get: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Browser
  browser: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: true },
  },
  internal_browser: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: true },
  },

  // MCP server tools
  mcp_tool: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Turn summary
  turn_summary: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Rate limit hint
  rate_limit_hint: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Compact boundary (context compacted marker)
  context_compacted: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Team discussion row (cloud session comment rendered in-stream)
  session_discussion: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Worktree
  worktree: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Setup repo
  setup_repo: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Canvas card
  canvas_inline: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Plan card
  plan_approval: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Generic fallback
  tool_call: {
    chat: {},
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },
};

// ============================================
// Chat Context Helpers
// ============================================

/**
 * Get chat context config for an event type.
 */
export function getChatContextConfig(
  eventType: string
): ChatContextConfig | null {
  const uiCanonical = getCliUiCanonical(eventType);
  return CONTEXT_CONFIG[uiCanonical]?.chat ?? null;
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
export function getActionConfig(actionType: string): ChatContextConfig | null {
  return getChatContextConfig(actionType);
}

/**
 * Check if component requires itemIndex prop
 */
export function requiresItemIndex(actionType: string): boolean {
  const config = getActionConfig(actionType);
  return config?.requiresItemIndex ?? false;
}
