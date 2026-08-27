/**
 * Global LSP Diagnostics Atom
 *
 * Stores per-file diagnostics received from LSP servers even when no editor
 * tab is open for the file.  This enables VS Code-style behaviour where
 * closing a tab keeps the last-known diagnostics visible in the Problems
 * panel.
 *
 * Updated from the LspClient WebSocket handler (outside React) via
 * getInstrumentedStore() — the same store the React tree uses.
 * Read by the EditorBottomPanel to merge with editor-specific and
 * workspace-scan diagnostics.
 */
import type { Diagnostic } from "@/src/modules/WorkStation/CodeEditor/Panels/EditorBottomPanel/content/ProblemsContent/types";
import { atom } from "jotai";

import {
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";

// Max number of files to cache diagnostics for (FIFO eviction)
const MAX_CACHED_FILES = 200;

/**
 * Map of filePath → Diagnostic[] for files whose diagnostics arrived
 * via the global WebSocket listener (i.e. no active per-file listener
 * was registered at the time).
 */
export const globalLspDiagnosticsAtom = atom<Map<string, Diagnostic[]>>(
  new Map()
);

/**
 * Update diagnostics for a single file in the global store.
 * Called from outside React (LspClient WebSocket handler).
 */
export function setGlobalLspDiagnostics(
  filePath: string,
  diagnostics: Diagnostic[]
): void {
  if (!isStoreInitialized()) return;
  const store = getInstrumentedStore();
  store.set(globalLspDiagnosticsAtom, (prev) => {
    const next = new Map(prev);
    if (diagnostics.length === 0) {
      next.delete(filePath);
    } else {
      // FIFO eviction when at capacity
      if (!next.has(filePath) && next.size >= MAX_CACHED_FILES) {
        const firstKey = next.keys().next().value;
        if (firstKey) next.delete(firstKey);
      }
      next.set(filePath, diagnostics);
    }
    return next;
  });
}
