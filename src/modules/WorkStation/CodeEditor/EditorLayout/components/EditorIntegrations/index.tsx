/**
 * EditorIntegrations Component
 *
 * Side-effect only component that handles all integration hooks.
 * These hooks don't contribute to rendering but provide important functionality:
 * - Git operations (push/pull/fetch/commit/stage), published via atom
 * - Editor go-to-line event bridge
 *
 * By isolating these in a separate component, we prevent unnecessary re-renders
 * of the main editor when integration state changes.
 *
 * The test runner, Output-panel streaming (git / task / file watch), LSP
 * diagnostics, and the GUIAgentService output bridge used to be wired here.
 * Those surfaces were archived — see `.archive/README.md`.
 */
import { useSetAtom } from "jotai";
import { type FC, memo, useEffect } from "react";

import { ACTION_ID, useActionSystem } from "@src/ActionSystem";
import { useGitOutputIntegration } from "@src/modules/WorkStation/CodeEditor/hooks/gitOutputIntegration/useGitOutputIntegration";
import { gitOutputIntegrationAtom } from "@src/store/workstation/codeEditor/outputIntegration";

// ============================================
// Types
// ============================================

export interface EditorIntegrationsProps {
  /** Repository path */
  repoPath: string;
  /** Repository ID (UUID or path) */
  repoId: string;
}

// ============================================
// Component
// ============================================

export const EditorIntegrations: FC<EditorIntegrationsProps> = memo(
  ({ repoPath, repoId }) => {
    // ============================================
    // Git Operations
    // ============================================
    const gitOutput = useGitOutputIntegration({
      repoPath,
      repoId, // Use actual repo ID (matches backend events)
    });

    // Make git operations available globally via atom
    const setGitOutputIntegration = useSetAtom(gitOutputIntegrationAtom);
    useEffect(() => {
      setGitOutputIntegration(gitOutput);
      return () => setGitOutputIntegration(null);
    }, [gitOutput, setGitOutputIntegration]);

    // ============================================
    // Editor Go To Line Event Handler
    // ============================================
    // Listen for go-to-line events dispatched from outside the provider
    const { dispatch } = useActionSystem();

    useEffect(() => {
      const handleGoToLine = (event: Event) => {
        const customEvent = event as CustomEvent<{ line: number }>;
        const { line } = customEvent.detail;
        dispatch(ACTION_ID.EDITOR_GO_TO_LINE, { line }, "user");
      };

      window.addEventListener("editor-go-to-line", handleGoToLine);
      return () =>
        window.removeEventListener("editor-go-to-line", handleGoToLine);
    }, [dispatch]);

    // This component is side-effect only - renders nothing
    return null;
  }
);

EditorIntegrations.displayName = "EditorIntegrations";

export default EditorIntegrations;
