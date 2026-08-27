/**
 * useDiagnostics Hook
 *
 * Manages diagnostics (lint errors, TypeScript errors) for the editor.
 * Provides a centralized state for collecting and managing diagnostics from CodeMirror.
 */
import type { Diagnostic } from "@/src/modules/WorkStation/CodeEditor/Panels/EditorBottomPanel/content/ProblemsContent/types";
import { useCallback, useMemo, useState } from "react";

// ============================================
// Types
// ============================================

export interface UseDiagnosticsOptions {
  /** Auto-clear diagnostics on file close (default: true) */
  autoClear?: boolean;
}

export interface UseDiagnosticsReturn {
  /** All diagnostics across all files */
  diagnostics: Diagnostic[];
  /** Get diagnostics for a specific file */
  getDiagnosticsForFile: (filePath: string) => Diagnostic[];
  /** Add diagnostics for a file (replaces existing) */
  setDiagnosticsForFile: (filePath: string, diagnostics: Diagnostic[]) => void;
  /** Add a single diagnostic */
  addDiagnostic: (diagnostic: Diagnostic) => void;
  /** Remove diagnostics for a file */
  clearDiagnosticsForFile: (filePath: string) => void;
  /** Clear all diagnostics */
  clearAllDiagnostics: () => void;
  /** Get count of errors and warnings */
  getCounts: () => { errors: number; warnings: number; total: number };
}

// ============================================
// Hook
// ============================================

/**
 * Hook to manage diagnostics across multiple files
 */
export function useDiagnostics(
  options: UseDiagnosticsOptions = {}
): UseDiagnosticsReturn {
  const { autoClear: _autoClear = true } = options;

  // State: Map of file path -> diagnostics
  const [diagnosticsByFile, setDiagnosticsByFile] = useState<
    Map<string, Diagnostic[]>
  >(new Map());

  // Flatten all diagnostics into a single array (memoized to prevent re-creation)
  const diagnostics = useMemo(() => {
    return Array.from(diagnosticsByFile.values()).flat();
  }, [diagnosticsByFile]);

  // Get diagnostics for a specific file
  const getDiagnosticsForFile = useCallback(
    (filePath: string): Diagnostic[] => {
      return diagnosticsByFile.get(filePath) || [];
    },
    [diagnosticsByFile]
  );

  // Set diagnostics for a file (replaces existing for that file)
  const setDiagnosticsForFile = useCallback(
    (filePath: string, diagnostics: Diagnostic[]) => {
      setDiagnosticsByFile((prev) => {
        const next = new Map(prev);
        if (diagnostics.length === 0) {
          next.delete(filePath);
        } else {
          next.set(filePath, diagnostics);
        }
        return next;
      });
    },
    []
  );

  // Add a single diagnostic
  const addDiagnostic = useCallback((diagnostic: Diagnostic) => {
    setDiagnosticsByFile((prev) => {
      const next = new Map(prev);
      const existing = next.get(diagnostic.filePath) || [];
      next.set(diagnostic.filePath, [...existing, diagnostic]);
      return next;
    });
  }, []);

  // Clear diagnostics for a file
  const clearDiagnosticsForFile = useCallback((filePath: string) => {
    setDiagnosticsByFile((prev) => {
      const next = new Map(prev);
      next.delete(filePath);
      return next;
    });
  }, []);

  // Clear all diagnostics
  const clearAllDiagnostics = useCallback(() => {
    setDiagnosticsByFile(new Map());
  }, []);

  // Get counts
  const getCounts = useCallback(() => {
    const errors = diagnostics.filter(
      (diagnostic) => diagnostic.severity === "error"
    ).length;
    const warnings = diagnostics.filter(
      (diagnostic) => diagnostic.severity === "warning"
    ).length;
    const total = diagnostics.length;
    return { errors, warnings, total };
  }, [diagnostics]);

  // Memoize the return object to prevent unnecessary re-renders in consumers
  return useMemo(
    () => ({
      diagnostics,
      getDiagnosticsForFile,
      setDiagnosticsForFile,
      addDiagnostic,
      clearDiagnosticsForFile,
      clearAllDiagnostics,
      getCounts,
    }),
    [
      diagnostics,
      getDiagnosticsForFile,
      setDiagnosticsForFile,
      addDiagnostic,
      clearDiagnosticsForFile,
      clearAllDiagnostics,
      getCounts,
    ]
  );
}
