/**
 * Diagnostics Store
 *
 * Health status tracking for diagnostic sources (LSP, ESLint).
 * Workspace scan state (persists across component mount/unmount).
 */
export {
  diagnosticHealthAtom,
  updateLspHealth,
  updateEslintHealth,
  resetDiagnosticHealth,
  lspInstallPromptAtom,
  dismissLspInstallPrompt,
  showLspInstallPrompt,
  lspRetryTriggerAtom,
  triggerLspRetry,
} from "./diagnosticHealthAtom";

export type {
  DiagnosticSourceStatus,
  DiagnosticSourceInfo,
  DiagnosticHealthState,
  LspInstallPromptState,
} from "./diagnosticHealthAtom";

export {
  isScanningAtom,
  scanProgressAtom,
  scanResultsAtom,
  scanScopeAtom,
  startWorkspaceScan,
  abortWorkspaceScan,
} from "./workspaceScanAtom";

export type { ScanScope, ScanProgress, ToolStatus } from "./workspaceScanAtom";

export {
  globalLspDiagnosticsAtom,
  setGlobalLspDiagnostics,
} from "./globalLspDiagnosticsAtom";
