/**
 * Renderer wrapper for `git-commit-detail` tabs.
 *
 * Renders `GitCommitDetailContent` through the unified dispatcher, pulling
 * repoPath / repoId / file-select from the hoisted Code Editor host context
 * and the commit metadata from tab data — a 1:1 mirror of
 * `TabContentRenderer`'s `case "git-commit-detail"`.
 */
import React, { Suspense, memo } from "react";

import { Placeholder } from "@src/components/Placeholder";
import { useEditorHostContext } from "@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/context/editorHostContext";

import type { UnifiedTabContentProps } from "../types";

const GitCommitDetailContent = React.lazy(
  () =>
    import("@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/GitCommitDetailContent")
);

const LazyFallback = () => (
  <Placeholder variant="loading" placement="detail-panel" fillParentHeight />
);

const GitCommitDetailTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const { repoPath, repoId, onFileSelect } = useEditorHostContext();

    const commitSha = String(tab.data.commitSha || "");
    const commitShortSha = String(tab.data.shortSha || "");
    const commitMsg = String(tab.data.commitMessage || "");
    const resolvedRepoId = repoId ?? repoPath;
    const repoReady = Boolean(repoPath && resolvedRepoId);

    return (
      <Suspense fallback={<LazyFallback />}>
        <GitCommitDetailContent
          commitSha={commitSha}
          shortSha={commitShortSha}
          commitMessage={commitMsg}
          repoPath={repoPath}
          repoId={resolvedRepoId}
          isRepoReady={repoReady}
          onFileSelect={onFileSelect}
        />
      </Suspense>
    );
  }
);

GitCommitDetailTabRenderer.displayName = "GitCommitDetailTabRenderer";

export default GitCommitDetailTabRenderer;
