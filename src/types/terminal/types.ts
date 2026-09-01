/**
 * Terminal shell profile types.
 *
 * These mirror the Rust-side types in `src-tauri/src/terminal/shells.rs`
 * and are returned by the `detect_available_shells` Tauri command.
 */

/** Categorized shell kind, matching the Rust ShellKind enum. */
export type ShellKind =
  | "zsh"
  | "bash"
  | "fish"
  | "sh"
  | "csh"
  | "ksh"
  | "pwsh"
  | "cmd"
  | "node"
  | "python"
  | "ruby"
  | "nushell"
  | "xonsh"
  | "unknown";

/** UI grouping category for shell profiles. */
type ShellCategory = "shell" | "repl";

/** A detected shell available on the system (from Rust detect_available_shells). */
export interface DetectedShell {
  /** Display name (e.g., "zsh", "Fish", "Node.js") */
  name: string;
  /** Absolute path to the shell executable */
  path: string;
  /** Classified shell kind */
  kind: ShellKind;
  /** UI grouping category */
  category: ShellCategory;
  /** Default arguments for interactive mode */
  default_args: string[];
  /** Whether this is the system default shell ($SHELL) */
  is_default: boolean;
}

/**
 * A shell profile used to create a terminal session.
 *
 * Combines detected shell info with user customization.
 * The `id` is used as the settings key for `terminal.defaultProfile`.
 */
export interface ShellProfile {
  /** Stable identifier (e.g., "zsh-default", "node-repl", "custom-1") */
  id: string;
  /** Display name for the UI */
  name: string;
  /** Absolute path to the shell executable */
  path: string;
  /** Shell arguments */
  args: string[];
  /** Shell kind for icon/behavior selection */
  kind: ShellKind;
  /** UI grouping category */
  category: ShellCategory;
  /** Custom environment variables */
  env?: Record<string, string>;
  /** Whether this is the system default shell */
  isDefault: boolean;
  /** Whether this was user-created (vs auto-detected) */
  isCustom: boolean;
}
