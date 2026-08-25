/**
 * Renderer wrapper for `file` tabs.
 *
 * Renders the code editor through the unified dispatcher, pulling the live
 * file-content manager + git status from the hoisted Code Editor host context
 * (`useEditorHostContext`) and the file path from tab data — a 1:1 mirror of
 * how `TabContentRenderer`'s `case "file"` mounts `CodeViewerContent`
 * (src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/TabContentRenderer/index.tsx).
 *
 * CRITICAL: `fileContentState` here is the SAME live instance the host holds
 * (`useFileContentManager`) — editing, dirty-diff baselines, and save/reload
 * all depend on it not being recreated per-tab.
 */
import React, { Suspense, memo } from "react";

import { getGitFileForPath } from "@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/sourceControlMainProps";
import { useEditorHostContext } from "@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/context/editorHostContext";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { requiresFilePreviewRoute as shouldUseDedicatedPreviewRoute } from "@src/util/file/previewTypes";

import type { UnifiedTabContentProps } from "../types";

const CodeViewerContent = React.lazy(
  () =>
    import("@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/CodeViewerContent")
);

const LazyFallback = () => (
  <Placeholder variant="loading" placement="detail-panel" fillParentHeight />
);

function isCsvTableFile(filePath: string): boolean {
  const lowerPath = filePath.toLowerCase();
  return lowerPath.endsWith(".csv") || lowerPath.endsWith(".tsv");
}

const FileTabRenderer: React.FC<UnifiedTabContentProps> = memo(({ tab }) => {
  const {
    fileContentState,
    gitFilesByPath,
    repoPath,
    onFileSelect,
    onCursorPositionChange,
    forceRefresh,
    onBinaryUnsavedChange,
  } = useEditorHostContext();

  const filePath = tab.data.filePath as string;
  // Look up git info for this file to get the base content (HEAD version)
  const gitFileInfo = filePath
    ? getGitFileForPath(filePath, repoPath, gitFilesByPath)
    : undefined;

  // Check if file was deleted (exists in git but removed from disk)
  // Also treat as deleted if we have git info with oldContent and file read failed
  const isDeletedFile =
    gitFileInfo?.status === "deleted" ||
    (fileContentState.error?.type === "not_found" &&
      gitFileInfo?.oldContent !== undefined);

  // Determine baseline for dirty diff:
  // - Deleted files: show oldContent with all lines marked as deleted
  // - Files in git status with "added": use "" to show all lines as green
  // - Files in git status with changes: use oldContent (HEAD version)
  // - Files not in git status: undefined → falls back to fileContent for unsaved changes
  const gitBaseContent = gitFileInfo
    ? gitFileInfo.status === "added"
      ? "" // Untracked file - compare against empty to show all green
      : gitFileInfo.status === "deleted"
        ? "" // Deleted file - compare against empty (we'll mark all as deleted)
        : gitFileInfo.oldContent
    : undefined;

  // For deleted files, show the old content instead of trying to read from disk
  const displayContent = isDeletedFile
    ? (gitFileInfo?.oldContent ?? "")
    : fileContentState.content;

  // Saved-on-disk content for unsaved changes diff (when file not in git status)
  const savedContent = isDeletedFile
    ? undefined
    : fileContentState.originalContent;

  return (
    <Suspense fallback={<LazyFallback />}>
      <CodeViewerContent
        selectedFile={filePath}
        fileContent={displayContent}
        loading={isDeletedFile ? false : fileContentState.loading}
        error={isDeletedFile ? null : fileContentState.error}
        repoPath={repoPath}
        onFileSelect={onFileSelect}
        onContentChange={fileContentState.handleContentChange}
        onSave={fileContentState.handleSave}
        onDiscard={fileContentState.handleDiscard}
        onReload={fileContentState.handleReload}
        hasUnsavedChanges={
          isDeletedFile
            ? false
            : isCsvTableFile(filePath)
              ? tab.hasUnsavedChanges === true ||
                fileContentState.hasUnsavedChanges
              : fileContentState.hasUnsavedChanges
        }
        saving={isDeletedFile ? false : fileContentState.saving}
        requiresFilePreviewRoute={
          isDeletedFile
            ? false
            : fileContentState.isBinary ||
              shouldUseDedicatedPreviewRoute(filePath)
        }
        defaultPreviewMode={tab.data.defaultPreviewMode as boolean}
        contentReady={isDeletedFile ? true : fileContentState.contentReady}
        onCursorPositionChange={onCursorPositionChange}
        onSaveSuccess={forceRefresh}
        onBinaryUnsavedChange={onBinaryUnsavedChange}
        gitBaseContent={gitBaseContent}
        savedContent={savedContent}
        isDeletedFile={isDeletedFile}
      />
    </Suspense>
  );
});

FileTabRenderer.displayName = "FileTabRenderer";

export default FileTabRenderer;
