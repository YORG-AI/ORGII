/**
 * ESLint Integration Service
 *
 * Provides ESLint diagnostics via Tauri commands.
 * This supplements the TypeScript LSP which doesn't report ESLint/Prettier errors.
 *
 * Requirements:
 * - Tauri app must be running (not just `npm run dev`)
 * - ESLint must be installed in the workspace
 * - ESLint config must exist (.eslintrc, eslint.config.js, etc.)
 */
import type { Diagnostic } from "@/src/modules/WorkStation/CodeEditor/Panels/EditorBottomPanel/content/ProblemsContent/types";

import { createLogger } from "@src/hooks/logger";

const log = createLogger("ESLint");

/**
 * ESLint diagnostic from Rust backend
 */
export interface EslintDiagnostic {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: "error" | "warning";
  message: string;
  source: string;
  code?: string;
}

// Track if we've already logged Tauri unavailability warning
let tauriWarningLogged = false;

/**
 * Dynamically invoke a Tauri command
 * Returns null if Tauri is not available
 */
async function tauriInvoke<T>(
  cmd: string,
  args: Record<string, unknown>
): Promise<T | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(cmd, args);
  } catch (error) {
    if (!tauriWarningLogged) {
      log.warn("[ESLint] Tauri not available:", error);
      tauriWarningLogged = true;
    }
    return null;
  }
}

/**
 * Run ESLint on a file
 */
export async function runEslint(filePath: string): Promise<EslintDiagnostic[]> {
  const diagnostics = await tauriInvoke<EslintDiagnostic[]>("eslint_run", {
    filePath,
  });
  return diagnostics ?? [];
}

/**
 * Run ESLint on content (for unsaved files)
 */
export async function runEslintOnContent(
  content: string,
  filePath: string
): Promise<EslintDiagnostic[]> {
  const diagnostics = await tauriInvoke<EslintDiagnostic[]>(
    "eslint_run_on_content",
    {
      content,
      filePath,
    }
  );

  return diagnostics ?? [];
}

/**
 * Check if ESLint is available for a workspace
 */
export async function isEslintAvailable(
  workspacePath: string
): Promise<boolean> {
  const result = await tauriInvoke<boolean>("eslint_is_available", {
    workspacePath,
  });
  return result ?? false;
}

/**
 * Get ESLint version
 */
export async function getEslintVersion(
  workspacePath: string
): Promise<string | null> {
  return await tauriInvoke<string | null>("eslint_get_version", {
    workspacePath,
  });
}

/**
 * Convert ESLint diagnostic to app Diagnostic format
 */
export function eslintDiagnosticToAppDiagnostic(
  eslintDiag: EslintDiagnostic,
  filePath: string
): Diagnostic {
  return {
    id: `eslint-${filePath}-${eslintDiag.line}-${eslintDiag.column}-${eslintDiag.code || "unknown"}`,
    filePath,
    line: eslintDiag.line,
    column: eslintDiag.column,
    // Convert null to undefined for endLine/endColumn (use line+1 char as fallback)
    endLine: eslintDiag.endLine ?? eslintDiag.line,
    endColumn: eslintDiag.endColumn ?? eslintDiag.column + 1,
    message: eslintDiag.message,
    severity: eslintDiag.severity,
    source: eslintDiag.source,
    code: eslintDiag.code,
  };
}

/**
 * Check if a file should be linted by ESLint
 */
export function supportsEslint(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase();
  return ["js", "jsx", "ts", "tsx", "mjs", "cjs", "vue", "svelte"].includes(
    ext || ""
  );
}
