/**
 * Git Output Integration Atom
 *
 * Stores the git output integration hook reference globally
 * so it can be accessed by git action handlers anywhere in the app.
 */
import { atom } from "jotai";

import type { UseGitOutputIntegrationReturn } from "@src/types/workstation/gitOutputIntegration";

/**
 * Global git output integration reference
 * Set by CodeEditor, consumed by git action handlers
 */
export const gitOutputIntegrationAtom =
  atom<UseGitOutputIntegrationReturn | null>(null);
