/**
 * LSP Service Exports
 *
 * Includes:
 * - LSP client for language server communication
 * - ESLint integration for style/formatting diagnostics
 * - Workspace lint scan utilities
 */

export { LspClient } from "./LspClient";
export type { LspClientOptions } from "./LspClient";
export { lspClientManager } from "./LspClientManager";
export * from "./types";

// ESLint integration
export {
  runEslint,
  runEslintOnContent,
  isEslintAvailable,
  getEslintVersion,
  eslintDiagnosticToAppDiagnostic,
  supportsEslint,
} from "./eslint";
export type { EslintDiagnostic } from "./eslint";

// Workspace scan utilities
export {
  workspaceDiagnosticToAppDiagnostic,
  getAvailableTools,
  runSingleTool,
} from "./workspaceScan";
export type {
  WorkspaceDiagnosticRaw,
  AvailableTool,
  SingleToolResult,
} from "./workspaceScan";
