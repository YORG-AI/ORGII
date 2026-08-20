/**
 * EditorIntegrations Component
 *
 * Side-effect only component that handles all integration hooks.
 * These hooks don't contribute to rendering but provide important functionality:
 * - Test runner auto-discovery
 * - Git output integration (streams git operations to Output panel)
 * - Task output integration (streams build/task operations to Output panel)
 * - File watch integration (displays file system events)
 * - LSP diagnostics
 * - GUIAgentService connection
 *
 * By isolating these in a separate component, we prevent unnecessary re-renders
 * of the main editor when integration state changes.
 */
import { useSetAtom } from "jotai";
import { type FC, memo, useCallback, useEffect } from "react";

import { ACTION_ID, useActionSystem } from "@src/ActionSystem";
import { useLspDiagnostics } from "@src/modules/WorkStation/CodeEditor/hooks/diagnostics/useLspDiagnostics";
import { useGitOutputIntegration } from "@src/modules/WorkStation/CodeEditor/hooks/gitOutputIntegration/useGitOutputIntegration";
import { useFileWatchOutputIntegration } from "@src/modules/WorkStation/CodeEditor/hooks/output/useFileWatchOutputIntegration";
import { useTaskOutputIntegration } from "@src/modules/WorkStation/CodeEditor/hooks/output/useTaskOutputIntegration";
import { useTestRunner } from "@src/modules/WorkStation/CodeEditor/hooks/useTestRunner";
import { GUIAgentService } from "@src/services";
import type {
  BottomPanelTab,
  PrimarySidebarTabKey,
} from "@src/store/ui/workStationAtom";
import {
  gitOutputIntegrationAtom,
  taskOutputIntegrationAtom,
} from "@src/store/workstation/codeEditor/outputIntegration";
import type { UseOutputChannelsReturn } from "@src/types/workstation/output";

// ============================================
// Types
// ============================================

export interface EditorIntegrationsProps {
  /** Repository path */
  repoPath: string;
  /** Repository ID (UUID or path) */
  repoId: string;
  /** Current primary sidebar tab for test runner activation */
  primarySidebarTab: PrimarySidebarTabKey;
  /** Output channels state for streaming output */
  outputState: UseOutputChannelsReturn;
  /** Bottom panel tab setter */
  setBottomPanelTab: (tab: BottomPanelTab) => void;
  /** Whether bottom panel is collapsed */
  bottomPanelCollapsed: boolean;
  /** Toggle bottom panel visibility */
  toggleBottomPanel: () => void;
}

// ============================================
// Component
// ============================================

export const EditorIntegrations: FC<EditorIntegrationsProps> = memo(
  ({
    repoPath,
    repoId,
    primarySidebarTab,
    outputState,
    setBottomPanelTab,
    bottomPanelCollapsed,
    toggleBottomPanel,
  }) => {
    // ============================================
    // Test Runner Integration
    // ============================================
    // Auto-discovers tests when testing panel is active
    useTestRunner({
      repoPath,
      autoDiscover: true,
      isActive: primarySidebarTab === "testing",
    });

    // ============================================
    // Git Output Integration
    // ============================================
    const onSwitchToGitOutput = useCallback(() => {
      setBottomPanelTab("output");
      if (bottomPanelCollapsed) {
        toggleBottomPanel();
      }
    }, [setBottomPanelTab, bottomPanelCollapsed, toggleBottomPanel]);

    const gitOutput = useGitOutputIntegration({
      outputState,
      repoPath,
      repoId, // Use actual repo ID (matches backend events)
      autoSwitchToOutput: false,
      onSwitchToOutput: onSwitchToGitOutput,
    });

    // Set Git channel as default active channel
    useEffect(() => {
      const gitChannelId = gitOutput.getGitChannelId();
      if (gitChannelId && !outputState.activeChannelId) {
        outputState.setActiveChannel(gitChannelId);
      }
    }, [gitOutput, outputState]);

    // Make git output integration available globally via atom
    const setGitOutputIntegration = useSetAtom(gitOutputIntegrationAtom);
    useEffect(() => {
      setGitOutputIntegration(gitOutput);
      return () => setGitOutputIntegration(null);
    }, [gitOutput, setGitOutputIntegration]);

    // ============================================
    // Task Output Integration
    // ============================================
    const onSwitchToTaskOutput = useCallback(() => {
      setBottomPanelTab("output");
      if (bottomPanelCollapsed) {
        toggleBottomPanel();
      }
    }, [setBottomPanelTab, bottomPanelCollapsed, toggleBottomPanel]);

    const taskOutput = useTaskOutputIntegration({
      outputState,
      cwd: repoPath,
      autoSwitchToOutput: false,
      onSwitchToOutput: onSwitchToTaskOutput,
    });

    // Make task output integration available globally via atom
    const setTaskOutputIntegration = useSetAtom(taskOutputIntegrationAtom);
    useEffect(() => {
      setTaskOutputIntegration(taskOutput);
      return () => setTaskOutputIntegration(null);
    }, [taskOutput, setTaskOutputIntegration]);

    // ============================================
    // File Watch Integration
    // ============================================
    useFileWatchOutputIntegration({
      outputState,
      repoId, // Use UUID if available, fallback to path
      repoPath,
      enabled: true, // Can be toggled via settings
    });

    // ============================================
    // LSP Diagnostics Integration
    // ============================================
    useLspDiagnostics({
      repoPath,
      enabled: true, // Add setting to toggle later
    });

    // ============================================
    // GUIAgentService Connection
    // ============================================
    useEffect(() => {
      GUIAgentService.connect(outputState);
      return () => GUIAgentService.disconnect();
    }, [outputState]);

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
