/**
 * LSP + ESLint combined linter extension for CodeMirror.
 *
 * For JS/TS files, runs both:
 * - LSP for type errors
 * - ESLint for style/formatting errors
 *
 * IMPORTANT: This function is designed to be non-blocking.
 * LSP initialization happens in the background and linting
 * returns immediately with cached/empty results if LSP isn't ready.
 *
 * Reports health status to the diagnosticHealthAtom so the Problems
 * panel can show actionable messages when sources fail.
 */
import type { Diagnostic } from "@/src/modules/WorkStation/CodeEditor/Panels/EditorBottomPanel/content/ProblemsContent/types";
import { lspClientManager } from "@/src/services/lsp/LspClientManager";
import {
  eslintDiagnosticToAppDiagnostic,
  runEslintOnContent,
  supportsEslint,
} from "@/src/services/lsp/eslint";
import { lspDiagnosticToAppDiagnostic } from "@/src/services/lsp/types";
import {
  lspRetryTriggerAtom,
  setGlobalLspDiagnostics,
  showLspInstallPrompt,
  updateEslintHealth,
  updateLspHealth,
} from "@/src/store/workstation/codeEditor/diagnostics";
import {
  getInstrumentedStore,
  isStoreInitialized,
} from "@/src/util/core/state/instrumentedStore";
import {
  type Diagnostic as CodeMirrorDiagnostic,
  linter,
} from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";

import { createLogger } from "@src/hooks/logger";

import { convertAndSortDiagnostics, withTimeout } from "./diagnosticsConverter";
import { LSP_MAX_RETRIES, LSP_RETRY_BASE_DELAY, LSP_TIMEOUT } from "./types";

const log = createLogger("Linter");

/**
 * Create LSP + ESLint combined linter extension.
 */
export function createLspLinterExtension(
  filePath: string,
  language: string,
  onDiagnosticsChange?: (diagnostics: Diagnostic[]) => void
): Extension {
  let lspClient: Awaited<
    ReturnType<typeof lspClientManager.getOrCreateClient>
  > | null = null;
  let lspDiagnosticsCache: Diagnostic[] = [];
  let eslintDiagnosticsCache: Diagnostic[] = [];
  const fileSupportsEslint = supportsEslint(filePath);

  // Capture the EditorView so background callbacks can nudge the linter
  let editorViewRef: EditorView | null = null;

  // Performance: Track LSP state to avoid blocking
  let lspFailed = false;
  let lspInitializing = false;
  let lspRetryCount = 0;
  let eslintFirstRun = true;

  // Performance: Cache last content to skip re-linting identical content
  let lastContentHash = "";

  // Track latest content so we can send didOpen after LSP init completes
  let latestContent = "";

  // Track whether this extension has been destroyed (editor unmounted)
  let destroyed = false;

  // Track whether we've positively heard from LSP at least once (even
  // an empty diagnostic set counts).  Until this is true,
  // combineAndReport() will NOT push results to the Problems panel so
  // it doesn't clear cached diagnostics from a previous session.
  let hasReceivedLspResults = false;

  // Track whether LSP is permanently unavailable so we can report
  // ESLint-only results without waiting for LSP forever.
  let lspPermanentlyFailed = false;

  const uri = `file://${filePath}`;

  // Defer store writes to avoid triggering React state updates during render
  // (this factory runs inside a useMemo in useEditorExtensions).
  queueMicrotask(() => {
    if (destroyed) return;
    setGlobalLspDiagnostics(filePath, []);
    updateLspHealth(language, "initializing");
    if (fileSupportsEslint) {
      updateEslintHealth("initializing");
    }
  });

  // --- Internal helpers (defined below) ---

  const combineAndReport = (): Diagnostic[] => {
    if (destroyed) return [];
    if (!hasReceivedLspResults && !lspPermanentlyFailed) return [];

    const seen = new Set<string>();
    const combined: Diagnostic[] = [];

    for (const diag of [...lspDiagnosticsCache, ...eslintDiagnosticsCache]) {
      const key = `${diag.line}:${diag.column}:${diag.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        combined.push(diag);
      }
    }

    if (onDiagnosticsChange) {
      onDiagnosticsChange(combined);
    }
    return combined;
  };

  // --- LSP retry scheduling ---

  const scheduleRetry = () => {
    if (lspRetryCount >= LSP_MAX_RETRIES || destroyed) return;
    const delay = LSP_RETRY_BASE_DELAY * Math.pow(2, lspRetryCount - 1);
    setTimeout(() => {
      if (destroyed) return;
      if (!lspClient && lspFailed) {
        lspFailed = false;
        initializeLspInBackground();
      }
    }, delay);
  };

  // --- LSP failure handler (shared by .then / .catch) ---

  const handleLspFailure = (errorMsg: string) => {
    lspClientManager
      .getInstallHint(language)
      .then((hint) => {
        if (destroyed) return;
        updateLspHealth(language, "failed", errorMsg, hint);
        if (lspPermanentlyFailed && hint) {
          showLspInstallPrompt(language, hint);
        }
      })
      .catch(() => {
        if (!destroyed) updateLspHealth(language, "failed", errorMsg);
      });
    scheduleRetry();
  };

  // --- LSP background initialization ---

  const initializeLspInBackground = () => {
    if (lspClient || lspInitializing || destroyed) return;
    if (lspFailed && lspRetryCount >= LSP_MAX_RETRIES) return;

    lspInitializing = true;
    updateLspHealth(language, "initializing");

    withTimeout(
      lspClientManager.getOrCreateClient(language),
      LSP_TIMEOUT,
      null as typeof lspClient
    )
      .then((client) => {
        lspInitializing = false;
        if (destroyed) return;

        if (client) {
          lspClient = client;
          lspFailed = false;
          lspRetryCount = 0;
          updateLspHealth(language, "active");

          lspClient.registerDiagnosticListener(uri, (lspDiagnostics) => {
            if (destroyed) return;
            hasReceivedLspResults = true;
            lspDiagnosticsCache = lspDiagnostics.map((lspDiag) =>
              lspDiagnosticToAppDiagnostic(lspDiag, filePath)
            );
            combineAndReport();
          });

          if (latestContent) {
            withTimeout(
              lspClient.didChange(uri, latestContent),
              LSP_TIMEOUT,
              undefined
            ).catch(() => {});
            lastContentHash = "";
          }
        } else {
          lspFailed = true;
          lspRetryCount++;
          if (lspRetryCount >= LSP_MAX_RETRIES) {
            lspPermanentlyFailed = true;
            combineAndReport();
          }
          const errorMsg =
            lspRetryCount >= LSP_MAX_RETRIES
              ? `Language server for ${language} not available after ${LSP_MAX_RETRIES} attempts`
              : `Language server for ${language} timed out (attempt ${lspRetryCount}/${LSP_MAX_RETRIES})`;
          log.warn(`[Linter] ${errorMsg}`);
          handleLspFailure(errorMsg);
        }
      })
      .catch((error: unknown) => {
        lspInitializing = false;
        if (destroyed) return;

        lspFailed = true;
        lspRetryCount++;
        if (lspRetryCount >= LSP_MAX_RETRIES) {
          lspPermanentlyFailed = true;
          combineAndReport();
        }
        const errorStr = error instanceof Error ? error.message : String(error);
        const errorMsg = `Language server for ${language} failed: ${errorStr}`;
        log.warn(`[Linter] ${errorMsg}`);
        handleLspFailure(errorMsg);
      });
  };

  // --- Retry trigger subscription ---

  let unsubRetryTrigger: (() => void) | null = null;
  if (isStoreInitialized()) {
    const store = getInstrumentedStore();
    unsubRetryTrigger = store.sub(lspRetryTriggerAtom, () => {
      if (destroyed) return;
      lspFailed = false;
      lspPermanentlyFailed = false;
      lspRetryCount = 0;
      lspInitializing = false;
      hasReceivedLspResults = false;
      updateLspHealth(language, "initializing");
      initializeLspInBackground();
    });
  }

  // --- Cleanup ---

  const cleanup = () => {
    destroyed = true;
    unsubRetryTrigger?.();
    if (lspClient) {
      lspClient.unregisterDiagnosticListener(uri);
      lspClient.didClose(uri).catch(() => {});
    }
  };

  // --- Lint function ---

  const lintFunction = async (
    view: EditorView
  ): Promise<CodeMirrorDiagnostic[]> => {
    const content = view.state.doc.toString();
    latestContent = content;

    const contentHash = `${content.length}-${content.slice(0, 100)}-${content.slice(Math.floor(content.length / 2), Math.floor(content.length / 2) + 100)}-${content.slice(-100)}`;
    if (contentHash === lastContentHash) {
      const allDiagnostics = [
        ...lspDiagnosticsCache,
        ...eslintDiagnosticsCache,
      ];
      return convertAndSortDiagnostics(allDiagnostics, view.state.doc);
    }
    lastContentHash = contentHash;

    // LSP: non-blocking
    initializeLspInBackground();

    if (lspClient && !lspFailed) {
      withTimeout(
        lspClient.didChange(uri, content),
        LSP_TIMEOUT,
        undefined
      ).catch(() => {});
    }

    // ESLint: fire-and-forget (non-blocking, like LSP).
    // Results update the cache and nudge CodeMirror to re-lint.
    if (fileSupportsEslint) {
      withTimeout(
        runEslintOnContent(content, filePath),
        LSP_TIMEOUT,
        [] as Awaited<ReturnType<typeof runEslintOnContent>>
      )
        .then((eslintResults) => {
          if (destroyed) return;
          eslintDiagnosticsCache = eslintResults.map((eslintDiag) =>
            eslintDiagnosticToAppDiagnostic(eslintDiag, filePath)
          );
          if (eslintFirstRun) {
            eslintFirstRun = false;
            updateEslintHealth("active");
          }
          combineAndReport();
          // Nudge CodeMirror to re-run linter with updated ESLint cache.
          // The content hash check prevents re-firing ESLint for the same content.
          if (editorViewRef) {
            editorViewRef.dispatch({ effects: [] });
          }
        })
        .catch((eslintError: unknown) => {
          if (destroyed) return;
          eslintDiagnosticsCache = [];
          if (eslintFirstRun) {
            eslintFirstRun = false;
            const errorStr =
              eslintError instanceof Error
                ? eslintError.message
                : String(eslintError);
            log.warn(`[Linter] ESLint failed: ${errorStr}`);
            updateEslintHealth("failed", errorStr);
          }
        });
    }

    // Return immediately with whatever diagnostics are cached (LSP + previous ESLint)
    const allDiagnostics = combineAndReport();
    return convertAndSortDiagnostics(allDiagnostics, view.state.doc);
  };

  // --- Extension assembly ---

  const lifecyclePlugin = ViewPlugin.define((view) => {
    editorViewRef = view;
    return {
      destroy() {
        editorViewRef = null;
        cleanup();
      },
    };
  });

  return [linter(lintFunction, { delay: 750 }), lifecyclePlugin];
}
