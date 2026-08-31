/**
 * Renderer for `github-pr-detail` tabs.
 *
 * Reconstructs a `PrIdentity` from the tab data and delegates to the existing
 * Source Control `PrDetailPanel`, which self-loads the full PR (Conversation /
 * Commits / Checks / Changes) via `useWorkstationPrDetail`. The shared tab
 * strip is published directly into the 40px workstation header.
 */
import { useAtomValue } from "jotai";
import React, { memo, useCallback, useMemo } from "react";

import { useWorkStationTabs } from "@src/hooks/tabHost/useWorkStationTabs";
import { usePublishWorkstationTabHeader } from "@src/hooks/tabHost/useWorkstationTabHeader";
import {
  PrDetailExternalLinkButton,
  PrDetailPanel,
  PrDetailTabs,
} from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/PullRequestContent/detail/PrDetailPanel";
import { resolvePullRequestDetailStatus } from "@src/shared/pr/prLevelActions";
import type { PrIdentity } from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";
import {
  workstationPrScopeKey,
  workstationSelectedPrAtomFamily,
} from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";
import { createFileTab } from "@src/store/workstation/tabs";
import type { GitHubPrDetailTabData } from "@src/store/workstation/tabs";

import type { UnifiedTabContentProps } from "../types";

const GitHubPrDetailTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const tabData = tab.data as unknown as GitHubPrDetailTabData;
    const { openTab } = useWorkStationTabs();
    const scopeKey = workstationPrScopeKey(
      tabData.repoId,
      tabData.repoPath,
      tabData.prNumber
    );
    const selectedPr = useAtomValue(workstationSelectedPrAtomFamily(scopeKey));

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
        status: resolvePullRequestDetailStatus(
          selectedPr.detail,
          tabData.prStatus
        ),
        headBranch: tabData.headBranch,
        baseBranch: tabData.baseBranch,
      }),
      [
        tabData.prNumber,
        tabData.prTitle,
        tabData.prUrl,
        tabData.prStatus,
        selectedPr.detail,
        tabData.headBranch,
        tabData.baseBranch,
      ]
    );

    const headerContent = useMemo(
      () => (
        <PrDetailTabs
          identity={identity}
          repoPath={tabData.repoPath}
          repoId={tabData.repoId}
          variant="header"
        />
      ),
      [identity, tabData.repoId, tabData.repoPath]
    );

    const headerTrailing = useMemo(
      () => <PrDetailExternalLinkButton identity={identity} />,
      [identity]
    );

    usePublishWorkstationTabHeader({
      host: "code",
      content: {
        content: headerContent,
        trailing: headerTrailing,
        shellLeadingChromeHidden: true,
      },
    });

    return (
      <PrDetailPanel
        identity={identity}
        repoPath={tabData.repoPath}
        repoId={tabData.repoId}
        tabsPlacement="hostHeader"
        onFileSelect={handleFileSelect}
      />
    );
  }
);

GitHubPrDetailTabRenderer.displayName = "GitHubPrDetailTabRenderer";

export default GitHubPrDetailTabRenderer;
