/**
 * Editor Actions (Zod-based)
 *
 * Actions for code editing operations (find, replace, undo, redo, format, etc.)
 */
import { z } from "zod";

import { ACTION_ID } from "@src/ActionSystem/actionIds";
import { defineZodAction } from "@src/ActionSystem/schema/defineZodAction";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";

// EditorService pulls @codemirror/{view,state,search,commands} statically.
// These actions are registered at app boot (GlobalShortcuts → ActionSystem),
// so load the service on first invocation instead of dragging CodeMirror
// into the startup graph.
const loadEditorService = () =>
  import("@src/services/workStation/EditorService").then(
    (mod) => mod.EditorService
  );

// ============================================
// Editor Actions
// ============================================

export const editorGoToLine = defineZodAction(
  {
    id: ACTION_ID.EDITOR_GO_TO_LINE,
    category: "editor",
    description: "Go to a specific line number",
    params: z.object({
      line: z
        .number()
        .int()
        .min(1, "Line must be at least 1")
        .describe("Line number to go to"),
    }),
    shortcut: getShortcutKeys("go_to_line"),
    examples: ["go to line 42", "jump to line 100"],
  },
  async ({ line }) => {
    const EditorService = await loadEditorService();
    const success = EditorService.goToLine(line);
    if (success) {
      return { success: true, message: `Went to line ${line}` };
    }
    return {
      success: false,
      message: EditorService.hasEditorView()
        ? `Failed to go to line ${line}`
        : "No editor is currently open",
    };
  }
);

export const editorFind = defineZodAction(
  {
    id: ACTION_ID.EDITOR_FIND,
    category: "editor",
    description: "Find text in the current file",
    params: z.object({
      query: z
        .string()
        .min(1, "Query cannot be empty")
        .describe("Text to find"),
      caseSensitive: z
        .boolean()
        .optional()
        .default(false)
        .describe("Case sensitive search"),
    }),
    shortcut: getShortcutKeys("find"),
    examples: ["find TODO", "search for function"],
  },
  async ({ query, caseSensitive }) => {
    const EditorService = await loadEditorService();
    const success = EditorService.find(query, { caseSensitive });
    if (success) {
      return { success: true, message: `Finding: ${query}` };
    }
    return {
      success: false,
      message: EditorService.hasEditorView()
        ? "Failed to open find panel"
        : "No editor is currently open",
    };
  }
);

export const editorReplace = defineZodAction(
  {
    id: ACTION_ID.EDITOR_REPLACE,
    category: "editor",
    description: "Find and replace text",
    params: z.object({
      find: z
        .string()
        .min(1, "Find text cannot be empty")
        .describe("Text to find"),
      replace: z.string().describe("Replacement text"),
      all: z
        .boolean()
        .optional()
        .default(false)
        .describe("Replace all occurrences"),
    }),
    shortcut: getShortcutKeys("find_replace"),
    examples: ["replace foo with bar"],
  },
  async ({ find, replace, all }) => {
    const EditorService = await loadEditorService();
    const success = EditorService.replace(find, replace, { all });
    if (success) {
      return {
        success: true,
        message: all
          ? `Replaced all "${find}" with "${replace}"`
          : `Replace "${find}" with "${replace}"`,
      };
    }
    return {
      success: false,
      message: EditorService.hasEditorView()
        ? "Failed to replace"
        : "No editor is currently open",
    };
  }
);

export const editorUndo = defineZodAction(
  {
    id: ACTION_ID.EDITOR_UNDO,
    category: "editor",
    description: "Undo last edit",
    params: z.object({}),
    shortcut: getShortcutKeys("undo"),
    examples: ["undo", "undo last change"],
  },
  async () => {
    const EditorService = await loadEditorService();
    const success = EditorService.undo();
    if (success) {
      return { success: true, message: "Undone" };
    }
    return {
      success: false,
      message: EditorService.hasEditorView()
        ? "Nothing to undo"
        : "No editor is currently open",
    };
  }
);

export const editorRedo = defineZodAction(
  {
    id: ACTION_ID.EDITOR_REDO,
    category: "editor",
    description: "Redo last undone edit",
    params: z.object({}),
    shortcut: getShortcutKeys("redo"),
    examples: ["redo", "redo last change"],
  },
  async () => {
    const EditorService = await loadEditorService();
    const success = EditorService.redo();
    if (success) {
      return { success: true, message: "Redone" };
    }
    return {
      success: false,
      message: EditorService.hasEditorView()
        ? "Nothing to redo"
        : "No editor is currently open",
    };
  }
);

export const editorFormat = defineZodAction(
  {
    id: ACTION_ID.EDITOR_FORMAT,
    category: "editor",
    description: "Format the current document",
    params: z.object({}),
    shortcut: "Shift+Alt+F",
    examples: ["format document", "format code", "prettify"],
  },
  async () => {
    const EditorService = await loadEditorService();
    const success = await EditorService.format();
    if (success) {
      return { success: true, message: "Document formatted" };
    }
    return {
      success: false,
      message:
        "Format not yet implemented (needs prettier/formatter integration)",
    };
  }
);

export const editorFold = defineZodAction(
  {
    id: ACTION_ID.EDITOR_FOLD,
    category: "editor",
    description: "Fold code regions",
    params: z.object({
      all: z.boolean().optional().default(false).describe("Fold all regions"),
    }),
    examples: ["fold all", "collapse code"],
  },
  async ({ all }) => {
    const EditorService = await loadEditorService();
    const success = EditorService.fold(all);
    return success
      ? { success: true, message: "Code folded" }
      : { success: false, message: "Fold not yet implemented" };
  }
);

export const editorUnfold = defineZodAction(
  {
    id: ACTION_ID.EDITOR_UNFOLD,
    category: "editor",
    description: "Unfold code regions",
    params: z.object({
      all: z.boolean().optional().default(false).describe("Unfold all regions"),
    }),
    examples: ["unfold all", "expand code"],
  },
  async ({ all }) => {
    const EditorService = await loadEditorService();
    const success = EditorService.unfold(all);
    return success
      ? { success: true, message: "Code unfolded" }
      : { success: false, message: "Unfold not yet implemented" };
  }
);

// ============================================
// Export all editor actions
// ============================================

export const editorZodActions = [
  editorGoToLine,
  editorFind,
  editorReplace,
  editorUndo,
  editorRedo,
  editorFormat,
  editorFold,
  editorUnfold,
];
