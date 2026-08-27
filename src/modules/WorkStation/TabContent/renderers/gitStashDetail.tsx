/**
 * Renderer wrapper for `git-stash-detail` tabs.
 *
 * Same shape as `git-commit-detail` with a stash-flavoured header
 * (`headerVariant="stash"`, `headerRootLabel={stashRef}`) — a 1:1 mirror of
 * `TabContentRenderer`'s `case "git-stash-detail"`. Pulls repoPath / repoId /
 * file-select from the hoisted Code Editor host context.
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

const GitStashDetailTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const { repoPath, repoId, onFileSelect } = useEditorHostContext();

    const commitSha = String(tab.data.commitSha || "");
    const commitShortSha = String(tab.data.shortSha || "");
    const commitMsg = String(tab.data.commitMessage || "");
    const stashRef = String(tab.data.stashRef || commitShortSha);
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
          headerVariant="stash"
          headerRootLabel={stashRef}
        />
      </Suspense>
    );
  }
);

GitStashDetailTabRenderer.displayName = "GitStashDetailTabRenderer";

export default GitStashDetailTabRenderer;
