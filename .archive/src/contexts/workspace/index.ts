/**
 * Workspace Contexts Index
 *
 * Barrel export for remaining workspace contexts
 *
 * MIGRATION STATUS (Mar 30, 2026):
 * ✅ StepContext → DELETED - use useStepState() from '@src/engines/SessionCore'
 * ✅ ReplayContext → DELETED - use useReplayState() from '@src/engines/SessionCore'
 * ✅ SessionContext → DELETED - use useWorkspaceSession() from '@src/engines/SessionCore'
 * ✅ UIContext → DELETED - use useWorkspaceUI() from '@src/engines/SessionCore'
 * ✅ SocketContext → DELETED (socket atoms also removed - not used)
 *
 * ⏳ Remaining (kept as React Context):
 * - ChatContext (UI state - width, scroll, model selection, feedback)
 * - DataContext (26 state values - consider splitting into atoms incrementally)
 *
 * For session and UI state, use:
 * ```tsx
 * import { useWorkspaceSession, useWorkspaceUI } from '@src/engines/SessionCore';
 * const { sessionShow, repositoryName } = useWorkspaceSession();
 * const { selectedTab, activeView } = useWorkspaceUI();
 * ```
 */
export * from "./ChatContext";
export * from "./DataContext";
