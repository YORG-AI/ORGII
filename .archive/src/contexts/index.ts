/**
 * Contexts - Main Barrel Export
 *
 * Centralized export point for all React contexts.
 * Reorganized by domain: git, workstation, session, workspace
 *
 * @example
 * // Direct imports (recommended)
 * import { useBrowserContext } from "@src/contexts/workstation";
 * import { useGitStatusContext } from "@src/contexts/git";
 *
 * // Or use namespace imports
 * import * as WorkStationContexts from "@src/contexts/workstation";
 * import * as GitContexts from "@src/contexts/git";
 */

// ============================================
// Re-export modules as namespaces
// ============================================

// Git contexts (single-repo and multi-repo status)
export * as GitContexts from "./git";

// Workstation contexts (Browser, Editor, Terminal, Files, Automation)
export * as WorkStationContexts from "./workstation";

// Session contexts (session list, recent files)
export * as SessionContexts from "./session";

// Workspace contexts (chat, data)
export * as WorkspaceContexts from "./workspace";
