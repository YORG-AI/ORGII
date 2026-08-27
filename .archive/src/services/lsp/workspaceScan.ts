/**
 * Workspace Lint Scanner Service
 *
 * Uses the orchestrated Rust backend for lint scanning:
 *   - `lint_scan_orchestrated` — runs all tools with deduplication & chunking
 *   - Events: lint:tool_started, lint:tool_completed
 *
 * The backend handles tool deduplication, ESLint chunking, and concurrency.
 */
import type { Diagnostic } from "@/src/modules/WorkStation/CodeEditor/Panels/EditorBottomPanel/content/ProblemsContent/types";

// ============================================
// Types
// ============================================

/** A single diagnostic returned from the Rust workspace scan */
export interface WorkspaceDiagnosticRaw {
  filePath: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: "error" | "warning" | "info";
  message: string;
  source: string;
  code?: string;
}

/** Info about an available lint tool */
export interface AvailableTool {
  id: string;
  name: string;
  enabled: boolean;
  installed: boolean;
  languages: string[];
}

/** Result of running a single lint tool */
export interface SingleToolResult {
  tool: string;
  diagnostics: WorkspaceDiagnosticRaw[];
  filesScanned: number;
  error: string | null;
}

// ============================================
// Conversion
// ============================================

/** Convert a raw workspace diagnostic to the app Diagnostic format */
export function workspaceDiagnosticToAppDiagnostic(
  raw: WorkspaceDiagnosticRaw
): Diagnostic {
  return {
    id: `${raw.source}-${raw.filePath}-${raw.line}-${raw.column}-${raw.code || "unknown"}`,
    filePath: raw.filePath,
    line: raw.line,
    column: raw.column,
    endLine: raw.endLine ?? raw.line,
    endColumn: raw.endColumn ?? raw.column + 1,
    message: raw.message,
    severity: raw.severity === "info" ? "info" : raw.severity,
    source: raw.source,
    code: raw.code ?? undefined,
  };
}

// ============================================
// Commands (used by workspaceScanAtom)
// ============================================

/** Get the list of available lint tools for this workspace */
export async function getAvailableTools(
  workspacePath: string
): Promise<AvailableTool[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AvailableTool[]>("lint_scan_get_tools", { workspacePath });
}

/** Run a single lint tool and return its raw diagnostics */
export async function runSingleTool(
  workspacePath: string,
  tool: string,
  targetDir?: string,
  filePaths?: string[]
): Promise<SingleToolResult> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SingleToolResult>("lint_scan_run_tool", {
    workspacePath,
    tool,
    targetDir: targetDir ?? null,
    filePaths: filePaths ?? null,
  });
}
