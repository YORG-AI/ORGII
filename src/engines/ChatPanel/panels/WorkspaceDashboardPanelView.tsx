import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useState } from "react";

import { LaunchpadDashboard } from "@src/modules/shared/launchpad/components";
import { openWorkspaceSpotlight } from "@src/scaffold/GlobalSpotlight/openSpotlight";
import { openWorkspaceOverviewInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import type { Repo } from "@src/store/repo";
import { repoLoadingAtom, reposAtom } from "@src/store/repo";
import { WORKSPACE_OVERVIEW_TAB } from "@src/store/ui/chatPanelAtom";

function repoDisplayName(repo: Repo): string {
  return repo.name || repo.path?.split("/").pop() || "Repo";
}

export default function WorkspaceDashboardPanelView(): React.ReactElement {
  const repos = useAtomValue(reposAtom);
  const loading = useAtomValue(repoLoadingAtom);
  const openWorkspaceTab = useSetAtom(openWorkspaceOverviewInChatPanelTabAtom);
  const [selectedDashboardRepoId, setSelectedDashboardRepoId] = useState<
    string | null
  >(null);

  // "Open details" opens the workspace overview / detail page in its own
  // dedicated chat-panel tab, titled with the workspace name and pre-selected
  // on the Details sub-tab. Re-opening the same workspace focuses the existing
  // tab instead of stacking duplicates.
  const handleOpenRepoDetails = useCallback(
    (repo: Repo) => {
      openWorkspaceTab({
        workspace: {
          kind: "repo",
          id: repo.id,
          name: repoDisplayName(repo),
          path: repo.path ?? undefined,
        },
        tab: WORKSPACE_OVERVIEW_TAB.DETAILS,
      });
    },
    [openWorkspaceTab]
  );

  return (
    <LaunchpadDashboard
      repos={repos}
      loading={loading}
      selectedDashboardRepoId={selectedDashboardRepoId}
      onSelectDashboardRepo={setSelectedDashboardRepoId}
      onOpenRepoDetails={handleOpenRepoDetails}
      onAddWorkspace={() => openWorkspaceSpotlight("add")}
    />
  );
}
