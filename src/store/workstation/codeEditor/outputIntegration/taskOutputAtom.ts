/**
 * Task Output Integration Atom
 *
 * Global state for task output integration.
 * Allows any component to trigger task execution with streaming output.
 */
import { atom } from "jotai";

import type { UseTaskOutputIntegrationReturn } from "@src/types/workstation/output";

/**
 * Global atom holding the task output integration instance
 *
 * Set by CodeEditor during initialization.
 * Used by other components (toolbar, command palette) to run tasks.
 */
export const taskOutputIntegrationAtom =
  atom<UseTaskOutputIntegrationReturn | null>(null);
