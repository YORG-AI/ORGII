import React, { useMemo } from "react";

import { PrDetailPanel } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/PullRequestContent/detail/PrDetailPanel";
import type { PrIdentity } from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";
import type { GitHubPrDetailTabData } from "@src/types/githubDetail";

export function GitHubPrPanelView({
  detail,
}: {
  detail: GitHubPrDetailTabData;
}): React.ReactNode {
  const identity = useMemo<PrIdentity>(
    () => ({
      number: detail.prNumber,
      title: detail.prTitle,
      url: detail.prUrl,
      status: detail.prStatus,
      headBranch: detail.headBranch,
      baseBranch: detail.baseBranch,
    }),
    [detail]
  );

  return (
    <PrDetailPanel
      identity={identity}
      repoPath={detail.repoPath}
      repoId={detail.repoId}
    />
  );
}
