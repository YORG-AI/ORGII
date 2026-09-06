/**
 * CodeMirror Shared Configuration
 *
 * Barrel re-export for all config modules.
 * Consumers can import from "./config" or "../config" as before.
 */

export { CODEMIRROR_STYLE_NONCE } from "./nonce";
export { codeMirrorCspNonceExtension } from "./csp";

// Theme configuration
export {
  CODEMIRROR_BASE_LAYOUT_THEME,
  getCodeMirrorTheme,
  createCodeMirrorTheme,
} from "./themeConfig";

// Editor extensions (indent guides, fold gutter)
export {
  editorHistoryKeymapExtension,
  findReplaceExtension,
  indentGuidesExtension,
  customFoldGutter,
  foldPlaceholderTheme,
} from "./extensions";

// Minimap
export { minimapExtension } from "./minimap";

// Go to line
export { goToLineExtension } from "./goToLine";

// BasicSetup presets
export { BASIC_SETUP_CONFIG, BASIC_SETUP_SQL_CONFIG } from "./setupConfig";

// Dirty diff gutter
export { dirtyDiffGutter } from "./dirtyDiff";

// Git blame inline annotation
export { gitBlameExtension } from "./gitBlame";
export type { BlameLineData } from "./gitBlame";
