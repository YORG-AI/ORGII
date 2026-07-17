/**
 * Renderer for `github-pr-detail` tabs.
 *
 * Reconstructs a `PrIdentity` from the tab data and delegates to the existing
 * Source Control `PrDetailPanel`, which self-loads the full PR (Conversation /
 * Commits / Checks / Changes) via `useWorkstationPrDetail`. The panel renders
 * its own header, so this renderer only disables the primary-sidebar toggle in
 * the tab-header strip while the PR fills the main pane.
 */
import React, { memo, useCallback, useMemo } from "react";

import { usePublishWorkstationTabHeader } from "@src/hooks/workStation";
import { useWorkStationTabs } from "@src/hooks/workStation/tabs/useWorkStationTabs";
import {
  PrDetailHeaderContent,
  PrDetailPanel,
} from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/PullRequestContent/detail/PrDetailPanel";
import type { PrIdentity } from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";
import { createFileTab } from "@src/store/workstation/tabs";
import type { GitHubPrDetailTabData } from "@src/store/workstation/tabs";

import type { UnifiedTabContentProps } from "../types";

const GitHubPrDetailTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const tabData = tab.data as unknown as GitHubPrDetailTabData;
    const { openTab } = useWorkStationTabs();

    const handleFileSelect = useCallback(
      (path: string) => {
        const absolutePath =
          path.startsWith("/") || !tabData.repoPath
            ? path
            : `${tabData.repoPath}/${path}`;
        openTab(createFileTab(absolutePath));
      },
      [openTab, tabData.repoPath]
    );

    const identity = useMemo<PrIdentity>(
      () => ({
        number: tabData.prNumber,
        title: tabData.prTitle,
        url: tabData.prUrl,
        status: tabData.prStatus,
        headBranch: tabData.headBranch,
        baseBranch: tabData.baseBranch,
      }),
      [
        tabData.prNumber,
        tabData.prTitle,
        tabData.prUrl,
        tabData.prStatus,
        tabData.headBranch,
        tabData.baseBranch,
      ]
    );

    const headerContent = useMemo(
      () => (
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <PrDetailHeaderContent
            identity={identity}
            baseBranch={identity.baseBranch ?? ""}
          />
        </span>
      ),
      [identity]
    );

    usePublishWorkstationTabHeader({
      host: "code",
      content: { content: headerContent, sidebarToggleDisabled: true },
    });

    return (
      <PrDetailPanel
        identity={identity}
        repoPath={tabData.repoPath}
        repoId={tabData.repoId}
        showHeader={false}
        onFileSelect={handleFileSelect}
      />
    );
  }
);

GitHubPrDetailTabRenderer.displayName = "GitHubPrDetailTabRenderer";

export default GitHubPrDetailTabRenderer;
