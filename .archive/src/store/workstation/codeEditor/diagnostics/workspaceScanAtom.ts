/**
 * Workspace Scan Atoms
 *
 * Persists scan state across component mount/unmount cycles.
 * When the user switches from Code Editor to another Human Tool
 * and back, the scan continues running and state is restored.
 *
 * Uses Rust backend orchestration for:
 * - Tool deduplication (Python: ruff > pylint > flake8)
 * - ESLint directory chunking
 * - Heavy tool concurrency limiting
 * - Event-based progress reporting
 */
import type { Diagnostic } from "@/src/modules/WorkStation/CodeEditor/Panels/EditorBottomPanel/content/ProblemsContent/types";
import { workspaceDiagnosticToAppDiagnostic } from "@/src/services/lsp/workspaceScan";
import { atom, type createStore } from "jotai";
import { atomWithStorage } from "jotai/utils";

import { createLogger } from "@src/hooks/logger";
import { workstationLayoutAtom } from "@src/store/workstation/tabs/atoms";

const logger = createLogger("WorkspaceScan");

type JotaiStore = ReturnType<typeof createStore>;

// ============================================
// Scan Scope
// ============================================

/** Which files the scan should cover */
export type ScanScope = "opened-tabs" | "diff" | "whole-repo";

/** Persisted scope preference (survives app restarts) */
export const scanScopeAtom = atomWithStorage<ScanScope>(
  "orgii:scan-scope",
  "whole-repo"
);

// ============================================
// Atoms (reactive, persist across mounts)
// ============================================

/** Whether a scan is currently in progress */
export const isScanningAtom = atom(false);

/** Per-tool progress info for the status bar */
export interface ToolStatus {
  name: string;
  status: "running" | "done" | "failed";
  diagnosticCount?: number;
  filesScanned?: number;
}

export interface ScanProgress {
  tools: ToolStatus[];
}

export const scanProgressAtom = atom<ScanProgress | null>(null);

/**
 * Accumulated diagnostics from the current/last scan, keyed by file path.
 * Updated incrementally as each tool completes. Components watch this
 * to sync results into the editor's diagnostics system.
 *
 * A monotonically increasing version counter is bumped on every update
 * so React can detect changes without deep-comparing the Map.
 */
export const scanResultsAtom = atom<{
  version: number;
  byFile: Map<string, Diagnostic[]>;
}>({ version: 0, byFile: new Map() });

// ============================================
// Module-level state (non-reactive)
// ============================================

/** Track abort state for cancellation */
let shouldAbort = false;

/** Event unsubscribe functions */
let unlisteners: Array<() => void> = [];

// ============================================
// Helpers — scope file sets
// ============================================

/** Collect all open file paths from the single main pane. */
function getOpenedFilePaths(store: JotaiStore): Set<string> {
  const layout = store.get(workstationLayoutAtom);
  const tabs = layout?.mainPane?.tabs ?? [];
  const paths = new Set<string>();
  for (const tab of tabs) {
    if (tab.type === "file" && tab.data.filePath) {
      paths.add(tab.data.filePath as string);
    }
  }
  return paths;
}

/** Get git-changed file paths via Rust backend. */
async function getDiffFilePaths(repoPath: string): Promise<Set<string>> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const paths = await invoke<string[]>("lint_scan_diff_files", {
      workspacePath: repoPath,
    });
    return new Set(paths);
  } catch (err) {
    logger.warn("Failed to get diff files:", err);
    return new Set();
  }
}

// ============================================
// Event Types from Rust Backend
// ============================================

interface LintToolStartedEvent {
  tool: string;
}

interface WorkspaceDiagnosticRaw {
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

interface LintToolCompletedEvent {
  tool: string;
  diagnostics: WorkspaceDiagnosticRaw[];
  filesScanned: number;
  error: string | null;
}

interface LintScanSummary {
  toolsRun: string[];
  totalDiagnostics: number;
  totalFilesScanned: number;
  errors: string[];
}

// ============================================
// Actions
// ============================================

/** Abort any in-progress scan without clearing results. */
export function abortWorkspaceScan(store?: JotaiStore): void {
  shouldAbort = true;

  // Clean up event listeners
  for (const unlisten of unlisteners) {
    unlisten();
  }
  unlisteners = [];

  if (store) {
    store.set(isScanningAtom, false);
  }
}

/**
 * Start an orchestrated workspace scan via Rust backend.
 *
 * The backend handles:
 * - Tool deduplication (Python: ruff > pylint > flake8)
 * - ESLint directory chunking
 * - Heavy tool concurrency limiting (max 2 Node.js tools)
 * - Progress events as each tool completes
 *
 * @param repoPath - Absolute path to the workspace
 * @param store - The Jotai store instance to write to
 * @param scope - Which files to scan (opened-tabs, diff, whole-repo)
 * @param selectedTools - When provided, only these tools run
 */
export function startWorkspaceScan(
  repoPath: string,
  store: JotaiStore,
  scope: ScanScope = "whole-repo",
  selectedTools?: Set<string>
): void {
  // Abort previous scan
  abortWorkspaceScan();
  shouldAbort = false;

  // Reset state
  store.set(isScanningAtom, true);
  store.set(scanProgressAtom, null);
  store.set(scanResultsAtom, { version: 0, byFile: new Map() });

  // Track tool statuses for progress
  const toolStatuses = new Map<string, ToolStatus>();

  const updateProgress = () => {
    store.set(scanProgressAtom, {
      tools: Array.from(toolStatuses.values()),
    });
  };

  const startScan = async () => {
    // Resolve scope file set
    let scopeFiles: string[] | undefined;

    if (scope === "opened-tabs") {
      const paths = getOpenedFilePaths(store);
      if (paths.size === 0) {
        store.set(isScanningAtom, false);
        logger.info("No open tabs to scan");
        return;
      }
      scopeFiles = Array.from(paths);
    } else if (scope === "diff") {
      const paths = await getDiffFilePaths(repoPath);
      if (paths.size === 0) {
        store.set(isScanningAtom, false);
        logger.info("No changed files to scan");
        return;
      }
      scopeFiles = Array.from(paths);
    }

    if (shouldAbort) return;

    logger.info(
      `Scope: ${scope}` +
        (scopeFiles ? ` (${scopeFiles.length} files)` : " (all files)")
    );

    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");

    // Set up event listeners
    const unlistenStarted = await listen<LintToolStartedEvent>(
      "lint:tool_started",
      (event) => {
        if (shouldAbort) return;

        const tool = event.payload.tool;
        toolStatuses.set(tool, {
          name: tool,
          status: "running",
        });
        updateProgress();

        logger.info(`${tool} started`);
      }
    );
    unlisteners.push(unlistenStarted);

    const unlistenCompleted = await listen<LintToolCompletedEvent>(
      "lint:tool_completed",
      (event) => {
        if (shouldAbort) return;

        const { tool, diagnostics, filesScanned, error } = event.payload;

        // Update tool status
        toolStatuses.set(tool, {
          name: tool,
          status: error ? "failed" : "done",
          diagnosticCount: diagnostics.length,
          filesScanned,
        });
        updateProgress();

        if (error) {
          logger.warn(`${tool} error:`, error);
        }

        if (diagnostics.length === 0) return;

        // Convert raw diagnostics to app format
        const appDiags = diagnostics.map(workspaceDiagnosticToAppDiagnostic);

        // Group by file
        const byFile = new Map<string, Diagnostic[]>();
        for (const diag of appDiags) {
          const existing = byFile.get(diag.filePath) || [];
          existing.push(diag);
          byFile.set(diag.filePath, existing);
        }

        // Merge into accumulated results
        const prev = store.get(scanResultsAtom);
        const merged = new Map(prev.byFile);
        for (const [filePath, fileDiags] of byFile) {
          const existing = merged.get(filePath) || [];
          merged.set(filePath, [...existing, ...fileDiags]);
        }
        store.set(scanResultsAtom, {
          version: prev.version + 1,
          byFile: merged,
        });

        logger.info(`${tool}: ${diagnostics.length} diagnostics`);
      }
    );
    unlisteners.push(unlistenCompleted);

    if (shouldAbort) {
      abortWorkspaceScan();
      return;
    }

    try {
      // Invoke the orchestrated scan
      const summary = await invoke<LintScanSummary>("lint_scan_orchestrated", {
        workspacePath: repoPath,
        toolOverrides: selectedTools ? Array.from(selectedTools) : null,
        scopeFiles: scopeFiles ?? null,
      });

      if (shouldAbort) return;

      // Final cleanup
      store.set(isScanningAtom, false);

      if (summary.errors.length > 0) {
        logger.warn("Errors:", summary.errors.join(", "));
      }
      logger.info(
        `Complete: ${summary.totalDiagnostics} diagnostics from [${summary.toolsRun.join(", ")}]`
      );
    } finally {
      // Clean up listeners
      for (const unlisten of unlisteners) {
        unlisten();
      }
      unlisteners = [];
    }
  };

  startScan().catch((err) => {
    logger.error("Unexpected error:", err);
    store.set(isScanningAtom, false);
    for (const unlisten of unlisteners) {
      unlisten();
    }
    unlisteners = [];
  });
}
