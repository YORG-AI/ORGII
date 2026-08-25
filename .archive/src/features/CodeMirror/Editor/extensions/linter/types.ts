import type { Diagnostic } from "@/src/modules/WorkStation/CodeEditor/Panels/EditorBottomPanel/content/ProblemsContent/types";

// ============================================
// Types
// ============================================

export interface LinterOptions {
  /** File path for this editor instance */
  filePath: string;
  /** Callback when diagnostics change */
  onDiagnosticsChange?: (diagnostics: Diagnostic[]) => void;
  /** Custom linter function (optional) */
  customLinter?: (content: string) => Diagnostic[];
}

// ============================================
// Constants
// ============================================

/** Timeout for LSP operations (ms) - prevents blocking on slow/unavailable servers */
export const LSP_TIMEOUT = 5000;

/** Max retry attempts for failed LSP initialization */
export const LSP_MAX_RETRIES = 3;

/** Delay between retries (ms) - exponential backoff: 2s, 4s, 8s */
export const LSP_RETRY_BASE_DELAY = 2000;
