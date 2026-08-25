/**
 * useLspDiagnostics Hook
 *
 * Initializes the LSP client manager with the repository root path.
 * This MUST be called before any CodeMirror linter extensions attempt
 * to create LSP clients, as they rely on the root path being set.
 *
 * The actual diagnostic flow goes through the CodeMirror linter extension:
 *   CodeMirror lintFunction → lspClientManager.getOrCreateClient()
 *   → LSP server → diagnostics event → onDiagnosticsChange callback
 *   → Problems panel
 *
 * Resets diagnostic health state on unmount or repo change.
 */
import { lspClientManager } from "@/src/services/lsp/LspClientManager";
import { resetDiagnosticHealth } from "@/src/store/workstation/codeEditor/diagnostics";
import { useEffect, useRef } from "react";

import { createLogger } from "@src/hooks/logger";

const logger = createLogger("LSP");

export interface UseLspDiagnosticsOptions {
  repoPath: string;
  enabled?: boolean;
}

export function useLspDiagnostics(options: UseLspDiagnosticsOptions) {
  const { repoPath, enabled = true } = options;
  const previousRepoPathRef = useRef<string>("");

  useEffect(() => {
    if (!enabled || !repoPath) return;

    // Only re-initialize if repo path actually changed
    if (repoPath === previousRepoPathRef.current) return;
    previousRepoPathRef.current = repoPath;

    // Set root path for LSP clients - this is critical for the
    // CodeMirror linter extension to create clients with the correct root
    lspClientManager.setRootPath(repoPath);
    logger.info(`Root path set to: ${repoPath}`);

    return () => {
      // Cleanup on unmount - shutdown all LSP servers and reset health
      lspClientManager.shutdown();
      resetDiagnosticHealth();
      previousRepoPathRef.current = "";
    };
  }, [enabled, repoPath]);
}
