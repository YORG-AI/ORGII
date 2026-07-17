/**
 * Renderer wrapper for `git-diff` tabs (also handles the timeline diff
 * variant where `tab.data.isTimeline === true`).
 *
 * Renders the historical / snapshot single-file diff through the unified
 * dispatcher, resolving the `GitFile` from the hoisted Code Editor host
 * context's `gitFilesByPath` map — a 1:1 mirror of `TabContentRenderer`'s
 * `case "git-diff"` (which keys the map by `tab.id` for timeline diffs and by
 * `tab.data.filePath` otherwise).
 */
import React, { Suspense, memo, useMemo } from "react";

import { useEditorHostContext } from "@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/context/editorHostContext";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import type { UnifiedTabContentProps } from "../types";

const GitDiffContent = React.lazy(
  () =>
    import("@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/GitDiffContent")
);

const LazyFallback = () => (
  <Placeholder variant="loading" placement="detail-panel" fillParentHeight />
);

const GitDiffTabRenderer: React.FC<UnifiedTabContentProps> = memo(({ tab }) => {
  const {
    gitFilesByPath,
    gitDiffLoading,
    repoPath,
    forceRefresh,
    onFileSelect,
    onGitDiffUnsavedChange,
  } = useEditorHostContext();

  const gitFile = useMemo(() => {
    const gitFileKey = tab.data.isTimeline
      ? tab.id
      : (tab.data.filePath as string);
    return gitFilesByPath.get(gitFileKey) || null;
  }, [tab, gitFilesByPath]);

  return (
    <Suspense fallback={<LazyFallback />}>
      <GitDiffContent
        gitFile={gitFile}
        loading={gitDiffLoading}
        repoPath={repoPath}
        onReload={forceRefresh}
        onFileSelect={onFileSelect}
        onUnsavedChange={onGitDiffUnsavedChange}
      />
    </Suspense>
  );
});

GitDiffTabRenderer.displayName = "GitDiffTabRenderer";

export default GitDiffTabRenderer;
