/**
 * StatusBarRenderer Component
 *
 * Reads per-app status bar state via activeStatusBarStateAtom and
 * activeStatusBarCallbacksAtom, then renders the appropriate variant.
 *
 * Each app writes to its own slot in perAppStatusBarStateAtom.
 * When the active app changes (via activeStatusBarAppAtom), this component
 * instantly shows the correct app's status bar — no stale data.
 */
import { useAtomValue } from "jotai";
import React, { memo } from "react";

import {
  activeStatusBarCallbacksAtom,
  activeStatusBarStateAtom,
} from "@src/store/ui/workStationAtom";

import BrowserStatusBar from "./BrowserStatusBar";
import { EditorStatusBar } from "./EditorStatusBar";
import ProjectStatusBar from "./ProjectStatusBar";

interface StatusBarRendererProps {
  floating?: boolean;
}

const FLOATING_STATUS_BAR_CLASS =
  "mx-2 !w-auto self-stretch rounded-lg border border-border-1 bg-[var(--cm-editor-background,var(--color-bg-1))] px-2 shadow-[0_2px_8px_rgb(0_0_0/0.03)]";

export const StatusBarRenderer: React.FC<StatusBarRendererProps> = memo(
  ({ floating = false }) => {
    const state = useAtomValue(activeStatusBarStateAtom);
    const callbacks = useAtomValue(activeStatusBarCallbacksAtom);
    const className = floating ? FLOATING_STATUS_BAR_CLASS : undefined;

    if (state.appType === "browser") {
      return (
        <BrowserStatusBar
          url={state.browserUrl ?? ""}
          isLoading={state.browserIsLoading ?? false}
          errorCount={state.browserErrorCount ?? 0}
          warningCount={state.browserWarningCount ?? 0}
          isDevToolsOpen={state.browserIsDevToolsOpen ?? false}
          onToggleDevTools={callbacks.onToggleDevTools ?? (() => {})}
          isPrivate={state.browserIsPrivate}
          sessionCount={state.browserSessionCount ?? 0}
          currentSessionIndex={state.browserCurrentSessionIndex ?? 0}
          hasSelectedElement={state.browserHasSelectedElement}
          selectedElementLabel={state.browserSelectedElementLabel}
          onSendSelectedElementToChat={callbacks.onSendSelectedElementToChat}
          onClearSelectedElement={callbacks.onClearSelectedElement}
          className={className}
        />
      );
    }

    if (state.appType === "project") {
      return (
        <ProjectStatusBar
          activeMemberCount={state.projectActiveMemberCount}
          totalMemberCount={state.projectTotalMemberCount}
          workItemCount={state.projectWorkItemCount}
          projectSlug={state.projectSlug}
          projectOrgId={state.projectOrgId}
          projectOrgName={state.projectOrgName}
          projectOrgGitFolderSyncEnabled={state.projectOrgGitFolderSyncEnabled}
          className={className}
        />
      );
    }

    return (
      <EditorStatusBar
        cursor={state.cursor}
        filePath={state.filePath || undefined}
        totalLines={state.totalLines}
        commitInfo={state.commitInfo}
        onRepoClick={callbacks.onRepoClick}
        onBranchClick={callbacks.onBranchClick}
        onWorktreeClick={callbacks.onWorktreeClick}
        className={className}
      />
    );
  }
);

StatusBarRenderer.displayName = "StatusBarRenderer";

export default StatusBarRenderer;
