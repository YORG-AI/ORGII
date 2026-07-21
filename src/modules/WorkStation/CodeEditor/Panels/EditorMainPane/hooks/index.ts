/**
 * EditorContent Hooks
 *
 * Barrel export for all hooks used by the EditorContent component.
 */

export { useEditorPaneState } from "./useEditorPaneState";
export { useFileContentManager } from "./useFileContentManager";
export type { UseFileContentManagerReturn } from "./useFileContentManager";
export { useSourceControlPaneActions } from "./useSourceControlPaneActions";
export type {
  UseSourceControlPaneActionsOptions,
  UseSourceControlPaneActionsReturn,
} from "./useSourceControlPaneActions";
export { useTabContentSync } from "./useTabContentSync";
export { useUnsavedChangeHandlers } from "./useUnsavedChangeHandlers";
export type {
  UseUnsavedChangeHandlersOptions,
  UseUnsavedChangeHandlersReturn,
} from "./useUnsavedChangeHandlers";
