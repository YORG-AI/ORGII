/**
 * Core Action Registration
 *
 * Registers all core editor actions at app initialization.
 * Actions call Services directly - no hook dependencies.
 *
 * Uses reference counting for multiple ActionSystemProvider instances:
 * - First provider to mount registers all actions
 * - Subsequent providers just increment the reference count
 * - Only when all providers unmount are actions unregistered
 *
 * All actions now use Zod-based schema system:
 * - terminalActions.zod.ts  - Terminal operations
 * - panelActions.zod.ts     - Panel visibility actions
 * - navigationActions.zod.ts - Code navigation
 * - searchActions.zod.ts    - Search operations
 * - testActions.zod.ts      - Test runner actions
 * - editorActions.zod.ts    - Code editing actions
 * - editorTabActions.zod.ts - Editor tab management
 * - fileActions.zod.ts      - File operations
 * - gitActions.zod.ts       - Git operations
 */
import type { ZodTypeAny } from "zod";

import type { ZodAction } from "@src/ActionSystem/schema/defineZodAction";
import { zodActionRegistry } from "@src/ActionSystem/schema/zodRegistry";
import { FileService } from "@src/services/file";
import { GitOperationsService, GitService } from "@src/services/git";
import { TestService } from "@src/services/test";

import { appViewZodActions } from "./actions/appViewActions.zod";
import { editorZodActions } from "./actions/editorActions.zod";
import { editorTabZodActions } from "./actions/editorTabActions.zod";
import { createFileZodActions, fileTabZodActions } from "./actions/file";
import { gitZodActions } from "./actions/git";
import { navigationZodActions } from "./actions/navigationActions.zod";
import { panelZodActions } from "./actions/panelActions.zod";
import { repoZodActions } from "./actions/repoActions.zod";
import { createSearchZodActions } from "./actions/searchActions.zod";
import { sessionCommentZodActions } from "./actions/sessionCommentActions.zod";
import { terminalZodActions } from "./actions/terminalActions.zod";
import { createTestZodActions } from "./actions/testActions.zod";
import { urlPreviewActions } from "./actions/urlPreviewActions.zod";
import { workStationViewZodActions } from "./actions/workStationViewActions.zod";

// Global state for reference counting
let registrationRefCount = 0;
let registeredZodActionIds: string[] = [];

/**
 * Build the full WorkStation core Zod action list (same array as registerCoreActions).
 * Does not touch the global registry — safe for schema / LLM tool smoke tests.
 */
export function getAllCoreZodActions(
  repoPath: string
): ZodAction<ZodTypeAny>[] {
  const testActions = createTestZodActions(repoPath);
  const searchActions = createSearchZodActions(repoPath);
  const fileActions = createFileZodActions(repoPath);

  return [
    ...terminalZodActions,
    ...panelZodActions,
    ...appViewZodActions,
    ...workStationViewZodActions,
    ...navigationZodActions,
    ...searchActions,
    ...testActions,
    ...editorZodActions,
    ...editorTabZodActions,
    ...fileActions,
    ...fileTabZodActions,
    ...gitZodActions,
    ...urlPreviewActions,
    ...repoZodActions,
    ...sessionCommentZodActions,
  ];
}

/**
 * Register all core actions
 * Uses reference counting to handle multiple ActionSystemProvider instances.
 *
 * @param repoPath - Current repository path
 * @returns Cleanup function to decrement ref count and unregister when count reaches 0
 */
export function registerCoreActions(repoPath: string): () => void {
  registrationRefCount++;

  // Actions already registered by another provider - just return cleanup
  if (registrationRefCount > 1) {
    return createCleanup();
  }

  // First registration - actually register all actions
  registeredZodActionIds = [];

  const allZodActions = getAllCoreZodActions(repoPath);

  // Register all actions
  zodActionRegistry.registerAll(allZodActions);
  registeredZodActionIds = allZodActions.map((action) => action.meta.id);

  return createCleanup();
}

function createCleanup(): () => void {
  return () => {
    registrationRefCount--;

    if (registrationRefCount > 0) {
      return;
    }

    // Last provider unmounted - unregister all actions
    zodActionRegistry.unregisterAll(registeredZodActionIds);
    registeredZodActionIds = [];
  };
}

/**
 * Initialize services (call once at app startup)
 * @param repoPath - Repository path
 * @param repoId - Optional repository ID (for git API operations)
 */
export async function initializeServices(
  repoPath: string,
  repoId?: string
): Promise<void> {
  FileService.setRepoPath(repoPath);
  if (repoId) {
    GitService.setRepoContext(repoId, repoPath);
    GitOperationsService.setRepoContext(repoId, repoPath);
  }
  await TestService.initialize();
}

/**
 * Cleanup services (call at app shutdown)
 */
export function cleanupServices(): void {
  TestService.cleanup();
}
