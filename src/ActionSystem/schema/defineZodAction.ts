/**
 * Zod-Based Action Definition System
 *
 * Provides single-source-of-truth action definitions with:
 * - Runtime validation via Zod
 * - TypeScript type inference via z.infer
 * - Automatic JSON Schema generation for LLM tools
 * - Self-documenting via .describe()
 *
 * @example
 * const myAction = defineZodAction(
 *   {
 *     id: "terminal.execute",
 *     category: "terminal",
 *     description: "Execute a command",
 *     params: z.object({
 *       command: z.string().min(1).describe("Command to run"),
 *     }),
 *   },
 *   async ({ command }) => {
 *     // command is fully typed as string
 *     return { success: true };
 *   }
 * );
 */
import { z } from "zod";

// ============================================
// Types
// ============================================

/**
 * Action category for grouping and filtering.
 *
 * WorkStation categories:
 *   file, editor, search, test, panel, terminal, git, view, debug, navigation
 *
 * App-level categories:
 *   app, sidebar, theme, tabs, spotlight, session, settings, repo
 */
export type ActionCategory =
  // WorkStation (code editor) categories
  | "file"
  | "editor"
  | "search"
  | "test"
  | "panel"
  | "terminal"
  | "git"
  | "view"
  | "debug"
  | "navigation"
  // App-level categories
  | "app"
  | "sidebar"
  | "theme"
  | "tabs"
  | "spotlight"
  | "session"
  | "settings"
  | "repo";

/**
 * Action layer determines how the action is exposed to the OS agent.
 *
 * - `"action"` — Pure logic with a native Rust backend equivalent (search, git, file CRUD).
 *   The OS agent uses its native tool. NOT exposed via `ide`. The frontend auto-mirrors
 *   these as GUI effects via useAgentGUISync (e.g., agent reads file → editor opens it).
 * - `"gui"` — UI manipulation (panels, tabs, view, navigation, file.open, test.run).
 *   Accessible via the `ide` tool for explicit GUI control.
 *
 * Defaults to `"gui"` if not specified.
 */
export type ActionLayer = "action" | "gui";

/**
 * Action metadata with Zod schema for parameters
 */
export interface ActionMeta<TParams extends z.ZodTypeAny> {
  /** Unique action ID (e.g., "file.open", "git.commit", "app.navigate") */
  id: string;

  /** Action category for grouping */
  category: ActionCategory;

  /** Human-readable description for LLM and documentation */
  description: string;

  /** Detailed description with examples (optional, for better LLM understanding) */
  longDescription?: string;

  /** Zod schema defining the action's parameters */
  params: TParams;

  /**
   * Action layer for OS agent exposure filtering.
   * - "action": Backend equivalent exists, use native tool instead
   * - "gui": UI control, accessible via `ide` tool
   * Defaults to "gui" if not specified.
   */
  layer?: ActionLayer;

  /** Whether AI should ask for confirmation before executing */
  requiresConfirmation?: boolean;

  /** Whether this action can be undone */
  undoable?: boolean;

  /** Keyboard shortcut (for documentation/binding) */
  shortcut?: string;

  /** Tags for filtering/grouping */
  tags?: string[];

  /** Example natural language commands that trigger this action */
  examples?: string[];
}

/**
 * Action result returned from executor
 */
export interface ActionResult {
  success: boolean;
  message?: string;
  data?: unknown;
}

/**
 * Action executor function type with inferred params
 */
export type ActionExecutor<TParams extends z.ZodTypeAny> = (
  params: z.infer<TParams>
) => Promise<ActionResult>;

/**
 * Complete Zod action with metadata and executor
 */
export interface ZodAction<TParams extends z.ZodTypeAny> {
  meta: ActionMeta<TParams>;
  execute: ActionExecutor<TParams>;
}

// ============================================
// Core Functions
// ============================================

/**
 * Define a type-safe action with Zod schema
 *
 * @example
 * export const fileOpen = defineZodAction(
 *   {
 *     id: "file.open",
 *     category: "file",
 *     description: "Open a file in the editor",
 *     params: z.object({
 *       path: z.string().describe("File path to open"),
 *     }),
 *   },
 *   async ({ path }) => {
 *     await FileService.open(path);
 *     return { success: true, message: `Opened ${path}` };
 *   }
 * );
 */
export function defineZodAction<TParams extends z.ZodTypeAny>(
  meta: ActionMeta<TParams>,
  execute: ActionExecutor<TParams>
): ZodAction<TParams> {
  return { meta, execute };
}

/**
 * Convert a Zod action to OpenAI-compatible function definition
 *
 * Used for LLM tool registration. Generates JSON Schema from Zod
 * and formats it for OpenAI's function calling API.
 */
export function zodActionToLLMTool<TParams extends z.ZodTypeAny>(
  action: ZodAction<TParams>
): LLMToolDefinition {
  const jsonSchema = z.toJSONSchema(action.meta.params, {
    target: "openApi3",
  });

  // Remove $schema property that Zod adds
  const { $schema: _schema, ...parameters } = jsonSchema as Record<
    string,
    unknown
  >;

  return {
    type: "function",
    function: {
      // Replace dots with underscores for OpenAI compatibility
      name: action.meta.id.replace(/\./g, "_"),
      description: action.meta.longDescription || action.meta.description,
      parameters,
    },
  };
}

/**
 * OpenAI-compatible tool definition structure
 */
export interface LLMToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

export interface GUIControlManifestAction {
  kind: "action";
  id: string;
  category: ActionCategory;
  description: string;
  longDescription?: string;
  layer: ActionLayer;
  requiresConfirmation?: boolean;
  undoable?: boolean;
  shortcut?: string;
  tags: string[];
  examples: string[];
  paramsSchema: unknown;
}

export interface GUIControlManifest {
  actions: GUIControlManifestAction[];
}

export function zodActionToGUIControlManifestAction<
  TParams extends z.ZodTypeAny,
>(action: ZodAction<TParams>): GUIControlManifestAction {
  const jsonSchema = z.toJSONSchema(action.meta.params, {
    target: "openApi3",
  });
  const { $schema: _schema, ...paramsSchema } = jsonSchema as Record<
    string,
    unknown
  >;

  return {
    kind: "action",
    id: action.meta.id,
    category: action.meta.category,
    description: action.meta.description,
    ...(action.meta.longDescription
      ? { longDescription: action.meta.longDescription }
      : {}),
    layer: action.meta.layer ?? "gui",
    ...(typeof action.meta.requiresConfirmation === "boolean"
      ? { requiresConfirmation: action.meta.requiresConfirmation }
      : {}),
    ...(typeof action.meta.undoable === "boolean"
      ? { undoable: action.meta.undoable }
      : {}),
    ...(action.meta.shortcut ? { shortcut: action.meta.shortcut } : {}),
    tags: action.meta.tags ?? [],
    examples: action.meta.examples ?? [],
    paramsSchema,
  };
}

// ============================================
// Helper Types for Consumers
// ============================================

/**
 * Extract the action ID from a ZodAction
 */
export type ActionId<T> =
  T extends ZodAction<z.ZodTypeAny> ? T["meta"]["id"] : never;
