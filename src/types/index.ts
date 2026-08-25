/**
 * Types - Main Barrel Export
 *
 * Centralized export point for all application types.
 * Reorganized by domain: core, session, editor, git, ui
 *
 * Note: Due to duplicate type names across modules, we don't use `export *`.
 * Import directly from specific modules instead:
 *
 * @example
 * // Direct imports (recommended)
 * import { Session } from "@src/types/session/session";
 * import { GitFile } from "@src/types/git/types";
 * import { UserProfileData } from "@src/types/core/user";
 *
 * // Or use namespace imports to avoid conflicts
 * import * as SessionTypes from "@src/types/session/session";
 * import * as GitTypes from "@src/types/git/types";
 * import * as CoreTypes from "@src/types/core";
 */

// ============================================
// Re-export modules as namespaces
// ============================================

// Core types (user, project, repo, workItem)
export * as CoreTypes from "./core";
export * as UserTypes from "./core/user";
export * as ProjectTypes from "./core/project";
export * as RepoTypes from "./core/repo";
export * as WorkItemTypes from "./core/workItem";
export * as SharedCoreTypes from "./core/shared";
export * as ViewStatusTypes from "./core/viewStatus";

// Session types
export * as SessionTypes from "./session/session";
export * as StepTypes from "./session/steps";

// Editor types
export * as EditorTypes from "./editor";
export * as DocumentTypes from "./editor/document";
export * as FileContentTypes from "./editor/fileContent";

// Git types
export * as GitTypes from "./git";

// UI types
export * as UITypes from "./ui";
export * as TabTypes from "./ui/tabs";
export * as AgentIconTypes from "./ui/agentIcons";
// Terminal types (shell profiles)
export * as TerminalTypes from "./terminal";

// Workspace types (multi-root)
export * as WorkspaceTypes from "./workspace";
