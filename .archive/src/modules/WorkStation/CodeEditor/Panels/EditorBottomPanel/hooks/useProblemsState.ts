/**
 * useProblemsState Hook
 *
 * Manages problems tab collapse/expand state and diagnostic merging.
 */
import { useCallback, useMemo, useState } from "react";

import type { Diagnostic } from "../content/ProblemsContent/types";

interface UseProblemsStateOptions {
  /** Editor diagnostics from active CodeMirror linter */
  diagnostics: Diagnostic[];
  /** Scan results byFile map */
  scanResultsByFile: Map<string, Diagnostic[]>;
  /** Global LSP diagnostics for files with no open tab */
  globalLspDiags: Map<string, Diagnostic[]>;
  onClearAllDiagnostics: () => void;
}

export function useProblemsState({
  diagnostics,
  scanResultsByFile,
  globalLspDiags,
  onClearAllDiagnostics,
}: UseProblemsStateOptions) {
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());

  // Merge three diagnostic sources, deduplicating by ID
  // Priority: scan > editor > global (first writer wins)
  const mergedDiagnostics = useMemo(() => {
    const scanDiags = Array.from(scanResultsByFile.values()).flat();
    const globalDiags = Array.from(globalLspDiags.values()).flat();

    const seen = new Map<string, Diagnostic>();

    for (const diag of scanDiags) {
      seen.set(diag.id, diag);
    }
    for (const diag of diagnostics) {
      if (!seen.has(diag.id)) {
        seen.set(diag.id, diag);
      }
    }
    for (const diag of globalDiags) {
      if (!seen.has(diag.id)) {
        seen.set(diag.id, diag);
      }
    }

    return Array.from(seen.values());
  }, [diagnostics, scanResultsByFile, globalLspDiags]);

  const groupedDiagnostics = useMemo(() => {
    const grouped = new Map<string, { filePath: string }>();
    for (const diag of mergedDiagnostics) {
      if (!grouped.has(diag.filePath)) {
        grouped.set(diag.filePath, { filePath: diag.filePath });
      }
    }
    return Array.from(grouped.values());
  }, [mergedDiagnostics]);

  const allCollapsed =
    groupedDiagnostics.length > 0 &&
    collapsedFiles.size === groupedDiagnostics.length;

  const handleToggleFileGroup = useCallback((filePath: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  }, []);

  const handleToggleExpandAll = useCallback(() => {
    if (allCollapsed) {
      setCollapsedFiles(new Set());
    } else {
      setCollapsedFiles(
        new Set(groupedDiagnostics.map((group) => group.filePath))
      );
    }
  }, [allCollapsed, groupedDiagnostics]);

  const handleClearAll = useCallback(() => {
    onClearAllDiagnostics();
    setCollapsedFiles(new Set());
  }, [onClearAllDiagnostics]);

  const resetCollapsedFiles = useCallback(() => {
    setCollapsedFiles(new Set());
  }, []);

  return {
    mergedDiagnostics,
    collapsedFiles,
    groupedDiagnostics,
    allCollapsed,
    handleToggleFileGroup,
    handleToggleExpandAll,
    handleClearAll,
    resetCollapsedFiles,
  };
}
