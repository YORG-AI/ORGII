/**
 * CodeMirror Feature Module
 *
 * Exports all CodeMirror-based editor components for WorkStation.
 */

// Editor component
export { CodeMirrorEditor } from "./Editor";
export type { CursorPosition, TextSelectionInfo } from "./Editor";

// Diff component
export { CodeMirrorDiff } from "./Diff";

// ConflictEditor component
export { CodeMirrorConflictEditor, hasConflictMarkers } from "./ConflictEditor";
export type { ConflictResolutionChoice } from "./ConflictEditor";

// SqlEditor component
export { SqlQueryEditor } from "./SqlEditor";
export { QueryResults } from "./SqlEditor/QueryResults";

// Shared config
export { createCodeMirrorTheme, getCodeMirrorTheme } from "./config";

// Shared language utilities
export {
  getLanguageExtension,
  getLanguageExtensionSync,
  getLanguageKey,
  loadLanguageExtension,
} from "./shared/languageExtensions";
