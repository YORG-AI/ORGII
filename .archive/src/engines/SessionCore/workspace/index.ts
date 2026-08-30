/**
 * Workspace Module
 *
 * Workspace-scoped state and hooks, migrated from contexts/workspace/.
 * Uses Jotai atoms instead of React Context for better performance
 * and global accessibility.
 *
 * Usage:
 * ```tsx
 * import { useWorkspaceSession, useWorkspaceUI } from "@src/engines/SessionCore/workspace";
 *
 * // Or via main session export:
 * import { useWorkspaceSession, sessionShowAtom } from "@src/engines/SessionCore";
 * ```
 */

// Atoms
export * from "./atoms";

// Hooks
export * from "./hooks";

// Note: Providers are optional with Jotai.
