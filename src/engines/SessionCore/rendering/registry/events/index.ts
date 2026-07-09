/**
 * Unified Event Registry
 *
 * Single source of truth for all event types and their components.
 * Uses Rust's `ui_canonical` as the key for component lookup.
 *
 * Architecture:
 * - `COMPONENT_LOADERS`: Maps ui_canonical → component loader
 * - `CONTEXT_CONFIG`: Maps ui_canonical → rendering metadata
 *
 * Resolution flow:
 *   toolName → resolveToolName() → ui_canonical → COMPONENT_LOADERS[ui_canonical]
 *
 * Event components support multiple contexts (chat, simulator, trajectory)
 * and internally handle rendering differences via a `variant` prop.
 *
 * INVARIANT
 * ---------
 * Every tool that declares a `chat_block` in Rust's `builtin_tools.rs` MUST
 * map to `chatBlockLoader` below. `chatBlockLoader` dispatches through
 * `RecipeRenderer` → `CHAT_BLOCKS[chat_block]`, so the Rust registry stays
 * the sole source of truth for which block renders.
 *
 * Entries that do NOT use `chatBlockLoader` must document the concrete
 * non-title behaviour that blocks unification (streaming with typewriter,
 * form input with submit flow, state-mutating clicks, etc.). Those are
 * the only legitimate exceptions.
 */
import React from "react";

import {
  getAllCliAliasKeys,
  getCliUiCanonical,
} from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import { resolveToolName } from "@src/engines/SessionCore/rendering/registry/toolAliases";
import {
  type EventCategory,
  getCategoryForUiCanonical,
} from "@src/engines/SessionCore/rendering/registry/toolCategories";
import type {
  ChatContextConfig,
  ComponentLoader,
  SimulatorContextConfig,
} from "@src/engines/SessionCore/rendering/registry/types";
import { createLogger } from "@src/hooks/logger";

// Re-export tool category utilities
export {
  getCategoryForUiCanonical,
  type EventCategory,
} from "@src/engines/SessionCore/rendering/registry/toolCategories";

const log = createLogger("UnifiedRegistry");

// ============================================
// Component Loaders by ui_canonical
// Keys match UiCanonical enum variants from Rust (snake_case)
// ============================================

/** Component loader functions keyed by ui_canonical */
export type ComponentLoaderMap = Record<string, ComponentLoader>;

/**
 * Bridge loader: every tool with a `chat_block` in Rust dispatches through
 * `RecipeRenderer`, which then picks the block from `CHAT_BLOCKS[chat_block]`.
 * This is the single seam between the event registry and the chat-block
 * system — do not inline `RecipeRenderer` imports elsewhere.
 */
const chatBlockLoader: ComponentLoader = () =>
  import("@src/engines/ChatPanel/rendering/index").then((mod) => ({
    default: mod.RecipeRenderer as React.ComponentType<unknown>,
  }));

export const COMPONENT_LOADERS: ComponentLoaderMap = {
  // ── Tool events ──
  // Data-driven via `chat_block` in Rust's `builtin_tools.rs`. Add new
  // tools here only after declaring their `chat_block` on the Rust side.
  read_file: chatBlockLoader,
  edit_file: chatBlockLoader,
  delete_file: chatBlockLoader,
  list_dir: chatBlockLoader,
  tool_search: chatBlockLoader,
  run_shell: chatBlockLoader,
  await_output: chatBlockLoader,
  inspect_terminals: chatBlockLoader,
  code_search: chatBlockLoader,
  web_search: chatBlockLoader,
  glob_file_search: chatBlockLoader,
  org_send_message: chatBlockLoader,
  subagent: chatBlockLoader,
  manage_todo: chatBlockLoader,
  task_create: chatBlockLoader,
  task_update: chatBlockLoader,
  task_list: chatBlockLoader,
  task_get: chatBlockLoader,
  mcp_tool: chatBlockLoader,
  browser: chatBlockLoader,
  internal_browser: chatBlockLoader,
  worktree: chatBlockLoader,
  setup_repo: chatBlockLoader,
  tool_call: chatBlockLoader,

  // ── Stream events ──
  // Custom render paths — NOT tool calls, have no `chat_block` in Rust.
  // Each carries behaviour the chat-block pipeline cannot express:
  //   `agent_message`     — itemIndex-aware typewriter + markdown streaming
  //   `thinking`          — reasoning-trace with custom collapse
  //   `user`              — user-authored chat bubble
  //   `turn_summary`      — stitches multiple child events into one card
  //   `context_compacted` — collapsed compact-boundary summary marker
  agent_message: () =>
    import("@src/engines/ChatPanel/events/stream/agent-message").then(
      (mod) => ({
        default: mod.AgentMessageEvent as React.ComponentType<unknown>,
      })
    ),
  thinking: () =>
    import("@src/engines/ChatPanel/events/stream/thinking").then((mod) => ({
      default: mod.ThinkingEvent as React.ComponentType<unknown>,
    })),
  user: () =>
    import("@src/engines/ChatPanel/events/stream/user-message").then((mod) => ({
      default: mod.UserEvent as React.ComponentType<unknown>,
    })),
  turn_summary: () =>
    import("@src/engines/ChatPanel/events/stream/turn-summary").then((mod) => ({
      default: mod.TurnSummaryEvent as React.ComponentType<unknown>,
    })),
  rate_limit_hint: () =>
    import("@src/engines/ChatPanel/events/stream/rate-limit-hint").then(
      (mod) => ({
        default: mod.RateLimitHintEvent as React.ComponentType<unknown>,
      })
    ),
  context_compacted: () =>
    import("@src/engines/ChatPanel/events/stream/context-compacted").then(
      (mod) => ({
        default: mod.ContextCompactedEvent as React.ComponentType<unknown>,
      })
    ),

  // ── Interactive events ──
  // State-mutating UI that owns its own input wiring. Custom render is
  // required because `ChatBlock` only carries display metadata:
  //   `ask_user_questions`   — form with submit flow (answers posted back)
  //   `ask_user_permissions` — approve/deny buttons on PermissionCard
  //   `suggest_mode_switch`  — clickable card mutating `creatorDefaultExecModeAtom`
  //   `suggest_next_steps`   — clickable cards that post a follow-up
  //
  // `plan_approval` uses chatBlockLoader (dispatches to `plan_doc` ChatBlock
  // → PlanDocAdapter). Explicit entry required so `_lazyComponentCache` is
  // keyed by "plan_approval" rather than the "tool_call" fallback key, and so
  // the async init race in `initToolRegistry` cannot silently downgrade the
  // card to a generic ToolCallBlock.
  plan_approval: chatBlockLoader,
  ask_user_questions: () =>
    import("@src/engines/ChatPanel/events/interactive_events/ask-question").then(
      (mod) => ({
        default: mod.AskQuestionEvent as React.ComponentType<unknown>,
      })
    ),
  ask_user_permissions: () =>
    import("@src/engines/ChatPanel/events/interactive_events/approval").then(
      (mod) => ({
        default: mod.ApprovalRequestEvent as React.ComponentType<unknown>,
      })
    ),
  suggest_mode_switch: () =>
    import("@src/engines/ChatPanel/events/interactive_events/mode-switch").then(
      (mod) => ({
        default: mod.ModeSwitchEvent as React.ComponentType<unknown>,
      })
    ),
  suggest_next_steps: () =>
    import("@src/engines/ChatPanel/events/interactive_events/next-step").then(
      (mod) => ({
        default: mod.NextStepEvent as React.ComponentType<unknown>,
      })
    ),
};

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

  // Plan card
  plan_approval: {
    chat: { requiresItemIndex: false, showStatusLine: false },
    simulator: { supportsSplitView: false, supportsFullscreen: false },
  },

  // Suggested next steps
  suggest_next_steps: {
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
// Preload Configuration
// Which components to preload on app start
// ============================================

export const PRELOAD_COMPONENTS = [
  "read_file",
  "edit_file",
  "run_shell",
  "code_search",
  "thinking",
  "agent_message",
] as const;

// Category helpers moved to toolCategories.ts
// Re-exported above for backwards compatibility

// ============================================
// Component Cache & Loading
// Bounded by the number of registered event types × contexts (~60 max).
// No eviction needed — entries are lazy-loaded components that live
// for the lifetime of the app.
// ============================================

const _componentCache = new Map<
  string,
  React.ComponentType<Record<string, unknown>>
>();

/**
 * In-flight loads to prevent duplicate dynamic imports for the same key.
 * Once a promise settles (resolves/rejects), its entry is removed.
 */
const _pendingLoads = new Map<
  string,
  Promise<React.ComponentType<Record<string, unknown>>>
>();

async function loadComponent(
  key: string,
  loader: () => Promise<unknown>
): Promise<React.ComponentType<Record<string, unknown>>> {
  const cached = _componentCache.get(key);
  if (cached) return cached;

  // Return in-flight promise if another call is already loading this key
  const pending = _pendingLoads.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const module = await loader();
    const mod = module as Record<string, unknown>;
    const component = (mod.default ||
      Object.values(mod).find(
        (exp) => typeof exp === "function"
      )) as React.ComponentType<Record<string, unknown>>;

    if (!component) {
      throw new Error(`Failed to extract component from module (key: ${key})`);
    }

    _componentCache.set(key, component);
    return component;
  })();

  _pendingLoads.set(key, promise);
  promise.finally(() => _pendingLoads.delete(key));

  return promise;
}

// ============================================
// Alias Resolution
// ============================================

/**
 * Resolve event type to primary type (handles aliases).
 * Delegates to the unified toolRegistry for alias resolution.
 */
export function resolveEventType(eventType: string): string {
  const resolved = resolveToolName(eventType);
  if (resolved !== eventType) return resolved;
  return eventType;
}

/**
 * Check if an event type is registered (has a component loader)
 */
export function isRegistered(eventType: string): boolean {
  const uiCanonical = getCliUiCanonical(eventType);
  return !!COMPONENT_LOADERS[uiCanonical];
}

/**
 * Get all registered event types (ui_canonical keys + CLI aliases from Rust).
 */
export function getAllEventTypes(): string[] {
  const types = new Set<string>();

  // Add all primary event types from COMPONENT_LOADERS
  for (const eventType of Object.keys(COMPONENT_LOADERS)) {
    types.add(eventType);
  }

  // Add all CLI aliases from Rust (runtime map)
  for (const alias of getAllCliAliasKeys()) {
    types.add(alias);
  }

  return Array.from(types);
}

/**
 * Get all event types by category
 */
export function getEventsByCategory(category: EventCategory): string[] {
  return Object.keys(COMPONENT_LOADERS).filter(
    (key) => getCategoryForUiCanonical(key) === category
  );
}

// ============================================
// Component Loading
// ============================================

/**
 * Synchronous cache lookup — returns immediately if the component was
 * previously loaded, otherwise null.
 * Components are context-independent: chat vs simulator is handled via props,
 * not separate modules.
 */
export function getEventComponentSync(
  eventType: string
): React.ComponentType<Record<string, unknown>> | null {
  const uiCanonical = getCliUiCanonical(eventType);
  if (!COMPONENT_LOADERS[uiCanonical]) return null;
  return _componentCache.get(uiCanonical) ?? null;
}

/**
 * Load event component.
 * Uses Rust's ui_canonical for direct lookup in COMPONENT_LOADERS.
 * Context (chat/simulator) is handled by the component internally via variant prop.
 */
export async function loadEventComponent(
  eventType: string
): Promise<React.ComponentType<Record<string, unknown>> | null> {
  const uiCanonical = getCliUiCanonical(eventType);
  const loader = COMPONENT_LOADERS[uiCanonical];

  if (!loader) {
    const fallbackLoader = COMPONENT_LOADERS["tool_call"];
    if (fallbackLoader) {
      try {
        return await loadComponent("tool_call", fallbackLoader);
      } catch {
        return null;
      }
    }
    return null;
  }

  try {
    return await loadComponent(uiCanonical, loader);
  } catch (error) {
    log.error(
      `[UnifiedRegistry] Failed to load ${eventType} (ui_canonical: ${uiCanonical}):`,
      error
    );
    return null;
  }
}

/**
 * Check if an event type has a registered component.
 */
export function supportsContext(eventType: string): boolean {
  const uiCanonical = getCliUiCanonical(eventType);
  return !!COMPONENT_LOADERS[uiCanonical];
}

/**
 * Preload common components based on priority.
 */
export async function preloadCommonComponents(): Promise<void> {
  if ("requestIdleCallback" in window) {
    requestIdleCallback(() => {
      for (const uiCanonical of PRELOAD_COMPONENTS) {
        loadEventComponent(uiCanonical).catch(() => {
          // Silently fail for preload
        });
      }
    });
  }
}

// ============================================
// Chat Context Helpers (for ActivityRouter)
// ============================================

// Lazy component cache — one per event type, created once
const _lazyComponentCache = new Map<
  string,
  React.LazyExoticComponent<React.ComponentType<Record<string, unknown>>>
>();

/**
 * Get a React.lazy() component for chat context rendering.
 * Returns a cached lazy component that can be used with <Suspense>.
 * Falls back to tool_call component for unknown event types.
 */
export function getChatLazyComponent(
  eventType: string
): React.LazyExoticComponent<React.ComponentType<Record<string, unknown>>> {
  const uiCanonical = getCliUiCanonical(eventType);

  const cached = _lazyComponentCache.get(uiCanonical);
  if (cached) return cached;

  const loader = COMPONENT_LOADERS[uiCanonical];

  const lazyComponent = React.lazy(async () => {
    if (loader) {
      const component = await loadComponent(uiCanonical, loader);
      return {
        default: component as React.ComponentType<Record<string, unknown>>,
      };
    }
    // Fallback to tool_call
    const fallbackLoader = COMPONENT_LOADERS["tool_call"];
    if (fallbackLoader) {
      const fallback = await loadComponent("tool_call", fallbackLoader);
      return {
        default: fallback as React.ComponentType<Record<string, unknown>>,
      };
    }
    // Ultimate fallback: empty component
    return { default: (() => null) as React.ComponentType<unknown> };
  }) as React.LazyExoticComponent<React.ComponentType<Record<string, unknown>>>;

  _lazyComponentCache.set(uiCanonical, lazyComponent);
  return lazyComponent;
}

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
