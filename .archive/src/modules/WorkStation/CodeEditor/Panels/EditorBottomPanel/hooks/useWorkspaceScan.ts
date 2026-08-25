/**
 * useWorkspaceScan Hook
 *
 * Encapsulates workspace scan state and actions:
 * - Jotai atom reads for scan progress/results
 * - Opens lint-scan tab in main pane (or aborts if scanning)
 */
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback } from "react";

import {
  abortWorkspaceScan,
  globalLspDiagnosticsAtom,
  isScanningAtom,
  scanResultsAtom,
} from "@src/store/workstation/codeEditor/diagnostics";
import {
  createLintScanTab,
  openTab,
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";

interface UseWorkspaceScanOptions {
  repoPath?: string;
}

export function useWorkspaceScan({ repoPath }: UseWorkspaceScanOptions) {
  const store = useStore();
  const isScanning = useAtomValue(isScanningAtom);
  const scanResults = useAtomValue(scanResultsAtom);
  const globalLspDiags = useAtomValue(globalLspDiagnosticsAtom);
  const setLayout = useSetAtom(workstationLayoutAtom);

  const handleOpenLintScan = useCallback(() => {
    if (isScanning) {
      abortWorkspaceScan(store);
      return;
    }
    if (!repoPath) return;
    const tab = createLintScanTab(repoPath);
    setLayout((prev) => ({
      ...prev,
      mainPane: openTab(prev?.mainPane ?? { tabs: [], activeTabId: null }, tab),
    }));
  }, [isScanning, repoPath, setLayout, store]);

  return {
    isScanning,
    scanResults,
    globalLspDiags,
    handleOpenLintScan,
  };
}
