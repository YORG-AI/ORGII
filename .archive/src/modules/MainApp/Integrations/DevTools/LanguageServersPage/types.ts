/**
 * Type definitions for Language Servers Page
 */

/** Language server info from Rust backend */
export interface LanguageServerInfo {
  language: string;
  displayName: string;
  command: string;
  installHint: string;
  installed: boolean;
  uninstallSupported: boolean;
}

export interface LintToolInfo {
  id: string;
  name: string;
  languages: string[];
  installHint: string;
  installed: boolean;
  version: string | null;
  uninstallSupported: boolean;
  /** The package manager binary required to install this tool (e.g. "npm", "pip3"). */
  requiresBinary: string | null;
  /** Whether the required binary is available (from cached dependency scan). */
  prerequisiteMet: boolean;
}

/** Install command result from backend */
export interface InstallCommandResult {
  command: string;
  packageManagerFound: boolean;
  error: string | null;
}

/** Uninstall command result from backend */
export interface UninstallCommandResult {
  command: string;
  packageManagerFound: boolean;
  uninstallSupported: boolean;
  error: string | null;
}

/** Workspace LSP config */
export interface WorkspaceLspConfig {
  disabled: string[];
}

/** Workspace Lint config */
export interface WorkspaceLintConfig {
  disabled: string[];
}

/** Install/uninstall status for tracking progress */
export type ActionStatus =
  | "idle"
  | "installing"
  | "uninstalling"
  | "success"
  | "failed";

export interface ActionState {
  status: ActionStatus;
  action?: "install" | "uninstall";
  command?: string;
  startTime?: number;
  errorMessage?: string;
}

/**
 * Direction of an LSP stdio log line.
 *
 * Mirrors the Rust `lsp::log_buffer::IoKind` enum (serde
 * `rename_all = "snake_case"`). Keep these values in sync — adding a
 * new variant requires updating both files.
 */
export type LspLogKind = "std_in" | "std_out" | "std_err";

/**
 * One entry from `lsp_get_server_log`. Mirrors the Rust
 * `lsp::log_buffer::LogLine` struct (serde
 * `rename_all = "camelCase"`).
 */
export interface LspLogLine {
  tsMs: number;
  kind: LspLogKind;
  line: string;
}
