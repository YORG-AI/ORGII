/**
 * Zod Action Registry
 *
 * Central registry for Zod-based actions with:
 * - Runtime validation via Zod schemas
 * - Detailed error messages with field paths
 * - LLM tool generation
 * - Subscription for reactive updates
 *
 * This is a singleton — all action registrations (app-level and WorkStation)
 * go into the same registry. The source of the registration doesn't matter.
 */
import { z } from "zod";

import { createLogger } from "@src/hooks/logger";

import type {
  ActionLayer,
  ActionResult,
  GUIControlManifest,
  LLMToolDefinition,
  ZodAction,
} from "./defineZodAction";
import {
  zodActionToGUIControlManifestAction,
  zodActionToLLMTool,
} from "./defineZodAction";

const log = createLogger("ZodActionRegistry");

// ============================================
// Registry Class
// ============================================

export class ZodActionRegistry {
  private actions = new Map<string, ZodAction<z.ZodTypeAny>>();
  private listeners = new Set<() => void>();

  // ==========================================
  // Registration
  // ==========================================

  /**
   * Register a single action
   */
  register<TParams extends z.ZodTypeAny>(action: ZodAction<TParams>): void {
    if (this.actions.has(action.meta.id)) {
      log.warn(`[ZodActionRegistry] Overwriting: ${action.meta.id}`);
    }
    this.actions.set(action.meta.id, action);
    this.notifyListeners();
  }

  /**
   * Register multiple actions at once
   */
  registerAll(actions: ZodAction<z.ZodTypeAny>[]): void {
    for (const action of actions) {
      this.actions.set(action.meta.id, action);
    }
    this.notifyListeners();
  }

  /**
   * Unregister an action by ID
   */
  unregister(actionId: string): void {
    this.actions.delete(actionId);
    this.notifyListeners();
  }

  /**
   * Unregister multiple actions
   */
  unregisterAll(actionIds: string[]): void {
    for (const id of actionIds) {
      this.actions.delete(id);
    }
    this.notifyListeners();
  }

  // ==========================================
  // Retrieval
  // ==========================================

  /**
   * Get an action by ID
   */
  get(actionId: string): ZodAction<z.ZodTypeAny> | undefined {
    return this.actions.get(actionId);
  }

  /**
   * Check if an action exists
   */
  has(actionId: string): boolean {
    return this.actions.has(actionId);
  }

  /**
   * Get all registered actions
   */
  getAll(): ZodAction<z.ZodTypeAny>[] {
    return Array.from(this.actions.values());
  }

  /**
   * Get all action IDs
   */
  getActionIds(): string[] {
    return Array.from(this.actions.keys());
  }

  /**
   * Get actions by category
   */
  getByCategory(category: string): ZodAction<z.ZodTypeAny>[] {
    return this.getAll().filter((action) => action.meta.category === category);
  }

  /**
   * Get actions by tag
   */
  getByTag(tag: string): ZodAction<z.ZodTypeAny>[] {
    return this.getAll().filter((action) => action.meta.tags?.includes(tag));
  }

  /**
   * Get actions by layer (defaults to "gui" when layer is not set)
   */
  getByLayer(layer: ActionLayer): ZodAction<z.ZodTypeAny>[] {
    return this.getAll().filter(
      (action) => (action.meta.layer ?? "gui") === layer
    );
  }

  /**
   * Get actions exposed to the agent's `ade` tool (Agentic Development Environment).
   * Returns only "gui" actions — "action" layer is excluded
   * because the agent has native Rust tools for those.
   * (The frontend auto-mirrors native tool calls as GUI effects
   * via useAgentGUISync, so the agent never needs to think about GUI.)
   */
  getADEExposedActions(): ZodAction<z.ZodTypeAny>[] {
    return this.getAll().filter((action) => {
      const layer = action.meta.layer ?? "gui";
      // Session actions are intentionally available through the ADE bridge
      // even though they are backend/control-plane actions. The OS agent
      // discovers them via inspect/list before dispatching manage_session
      // flows such as session.create / session.list / session.sendMessage.
      return layer === "gui" || action.meta.category === "session";
    });
  }

  getGUIControlManifest(): GUIControlManifest {
    return {
      actions: this.getADEExposedActions()
        .map(zodActionToGUIControlManifestAction)
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  /**
   * Get the effective layer for a given action ID.
   * Returns undefined if the action is not registered.
   */
  getActionLayer(actionId: string): ActionLayer | undefined {
    const action = this.actions.get(actionId);
    if (!action) return undefined;
    return action.meta.layer ?? "gui";
  }

  // ==========================================
  // Execution
  // ==========================================

  /**
   * Execute an action with Zod validation
   *
   * @param actionId - The action ID to execute
   * @param rawPayload - Unvalidated payload (will be validated by Zod)
   * @returns Action result with success status and message
   */
  async execute(actionId: string, rawPayload: unknown): Promise<ActionResult> {
    const action = this.actions.get(actionId);

    if (!action) {
      return {
        success: false,
        message: `Unknown action: ${actionId}`,
      };
    }

    // Validate with Zod - get detailed error messages
    const parseResult = action.meta.params.safeParse(rawPayload);

    if (!parseResult.success) {
      const issues = parseResult.error.issues
        .map((issue) => {
          const path = issue.path.length > 0 ? issue.path.join(".") : "root";
          return `${path}: ${issue.message}`;
        })
        .join("; ");

      return {
        success: false,
        message: `Validation failed: ${issues}`,
      };
    }

    // Execute with validated params
    try {
      const result: unknown = await action.execute(parseResult.data);

      if (
        !result ||
        typeof result !== "object" ||
        typeof (result as Partial<ActionResult>).success !== "boolean"
      ) {
        return {
          success: false,
          message: `Execution failed: Action ${actionId} returned an invalid result`,
        };
      }

      return result as ActionResult;
    } catch (error) {
      return {
        success: false,
        message: `Execution failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // ==========================================
  // LLM Integration
  // ==========================================

  /**
   * Get all actions as LLM tool definitions
   */
  getLLMTools(): LLMToolDefinition[] {
    return Array.from(this.actions.values()).map(zodActionToLLMTool);
  }

  /**
   * Get LLM tools filtered by category
   */
  getLLMToolsByCategory(category: string): LLMToolDefinition[] {
    return this.getByCategory(category).map(zodActionToLLMTool);
  }

  /**
   * Build system prompt section describing available actions
   */
  buildSystemPrompt(): string {
    const categories = new Map<string, ZodAction<z.ZodTypeAny>[]>();

    for (const action of this.actions.values()) {
      const existing = categories.get(action.meta.category) || [];
      categories.set(action.meta.category, [...existing, action]);
    }

    const parts = ["## Available Actions\n"];

    for (const [category, categoryActions] of categories) {
      parts.push(
        `### ${category.charAt(0).toUpperCase() + category.slice(1)} Actions`
      );

      for (const action of categoryActions) {
        parts.push(`- **${action.meta.id}**: ${action.meta.description}`);
        if (action.meta.examples && action.meta.examples.length > 0) {
          parts.push(`  Examples: "${action.meta.examples.join('", "')}"`);
        }
      }
      parts.push("");
    }

    return parts.join("\n");
  }

  // ==========================================
  // Subscription
  // ==========================================

  /**
   * Subscribe to registry changes
   * @returns Unsubscribe function
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  // ==========================================
  // Debug
  // ==========================================

  /**
   * Get registry stats for debugging
   */
  getStats(): { total: number; byCategory: Record<string, number> } {
    const byCategory: Record<string, number> = {};

    for (const action of this.actions.values()) {
      byCategory[action.meta.category] =
        (byCategory[action.meta.category] || 0) + 1;
    }

    return {
      total: this.actions.size,
      byCategory,
    };
  }
}

// ============================================
// Singleton Instance
// ============================================

/**
 * Global Zod action registry instance.
 *
 * Both app-level actions and WorkStation actions register here.
 * This is the single source of truth for all dispatchable actions.
 */
export const zodActionRegistry = new ZodActionRegistry();
