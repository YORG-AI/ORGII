/**
 * PrChangesTab
 *
 * GitHub's "Files changed": the file list comes from the PR files API
 * (`state.files`), and each file's before/after content is read from the
 * GitHub Contents API by commit SHA (`usePrFileContent`). Nothing is fetched
 * into the local clone, so the diff **auto-loads** — no "Fetch PR" step —
 * while still rendering with the same `GitFileList` + `CodeMirrorDiff`
 * side-by-side formatting as the commit-history view.
 */
import { useAtom, useAtomValue } from "jotai";
import { ChevronRight } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { GitHubReviewComment, PrFile } from "@src/api/tauri/github";
import { Placeholder } from "@src/components/Placeholder";
import type { GitFileStatus } from "@src/config/gitStatus";
import { CodeMirrorDiff } from "@src/features/CodeMirror";
import {
  FileHeader,
  GIT_FILE_LIST_MAX_WIDTH,
  GIT_FILE_LIST_MIN_WIDTH,
  GitFileList,
  gitFileListWidthAtom,
} from "@src/modules/WorkStation/shared";
import { VerticalResizeHandle, useColumnResize } from "@src/scaffold/Resize";
import {
  editorHighlightActiveLineAtom,
  editorLineNumbersAtom,
  editorWordWrapAtom,
} from "@src/store/ui/editorSettingsAtom";
import { activeStatusBarCallbacksAtom } from "@src/store/ui/workStationAtom";
import { diffViewModeAtom } from "@src/store/workstation/codeEditor";
import type { GitFile } from "@src/types/git/types";

import { PrReviewThreadsPanel } from "./PrReviewThreadsPanel";
import { formatPrFilesCount } from "./prFilesDisplay";
import { usePrFileContent } from "./usePrFileContent";

function readNestedString(
  detail: Record<string, unknown> | null,
  path: string[]
): string | null {
  let cursor: unknown = detail;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "string" ? cursor : null;
}

function mapPrFileStatus(status: string): GitFileStatus {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    default:
      return "modified";
  }
}

interface PrChangesTabProps {
  repoFullName: string | null;
  detail: Record<string, unknown> | null;
  headSha: string | null;
  baseRef: string | null;
  files: PrFile[];
  loading: boolean;
  reviewComments: GitHubReviewComment[];
  selectedFilePath?: string | null;
  onSelectedFilePathChange?: (path: string | null) => void;
  onFileSelect?: (path: string) => void;
  onReplyInlineComment?: (commentId: number, body: string) => Promise<void>;
}

export const PrChangesTab: React.FC<PrChangesTabProps> = ({
  repoFullName,
  detail,
  headSha,
  baseRef,
  files,
  loading,
  reviewComments,
  selectedFilePath: controlledSelectedFilePath,
  onSelectedFilePathChange,
  onFileSelect,
  onReplyInlineComment,
}) => {
  const { t } = useTranslation("common");

  const [fileListCollapsed, setFileListCollapsed] = useState(false);
  const [viewMode, setViewMode] = useAtom(diffViewModeAtom);
  const [lineNumbers, setLineNumbers] = useAtom(editorLineNumbersAtom);
  const [wordWrap, setWordWrap] = useAtom(editorWordWrapAtom);
  const [highlightActiveLine, setHighlightActiveLine] = useAtom(
    editorHighlightActiveLineAtom
  );
  const { onOpenSettings } = useAtomValue(activeStatusBarCallbacksAtom);
  const [fileListWidth, setFileListWidth] = useAtom(gitFileListWidthAtom);
  const { columnRef: fileListRef, handleMouseDown: handleFileListResize } =
    useColumnResize({
      width: fileListWidth,
      setWidth: setFileListWidth,
      min: GIT_FILE_LIST_MIN_WIDTH,
      max: GIT_FILE_LIST_MAX_WIDTH,
    });
  const setFileListElement = useCallback(
    (node: HTMLDivElement | null) => {
      fileListRef.current = node;
    },
    [fileListRef]
  );

  // GitHub's diff base is the merge-base, not the current base branch tip.
  const baseSha = useMemo(
    () =>
      readNestedString(detail, ["merge_base_sha"]) ??
      readNestedString(detail, ["base", "sha"]) ??
      baseRef ??
      null,
    [detail, baseRef]
  );

  const gitFiles: GitFile[] = useMemo(
    () =>
      files.map((file) => ({
        id: file.filename,
        path: file.filename,
        status: mapPrFileStatus(file.status),
        additions: file.additions,
        deletions: file.deletions,
        staged: true,
      })),
    [files]
  );

  // Derive the effective selection instead of syncing it in an effect: honor
  // the user's pick while it's still in the changed-file set, else the first
  // file. Falling back keeps a valid selection as files load without a
  // set-state-in-effect.
  const [internalSelectedFilePath, setInternalSelectedFilePath] = useState<
    string | null
  >(null);
  const requestedFilePath =
    controlledSelectedFilePath !== undefined
      ? controlledSelectedFilePath
      : internalSelectedFilePath;
  const updateSelectedFilePath = useCallback(
    (path: string | null) => {
      if (controlledSelectedFilePath !== undefined) {
        onSelectedFilePathChange?.(path);
        return;
      }
      setInternalSelectedFilePath(path);
    },
    [controlledSelectedFilePath, onSelectedFilePathChange]
  );
  const selectedFilePath = useMemo(() => {
    if (
      requestedFilePath &&
      files.some((f) => f.filename === requestedFilePath)
    ) {
      return requestedFilePath;
    }
    return files[0]?.filename ?? null;
  }, [requestedFilePath, files]);

  const selectedFile = useMemo(
    () => files.find((f) => f.filename === selectedFilePath) ?? null,
    [files, selectedFilePath]
  );

  const {
    oldContent,
    newContent,
    isBinary,
    truncated,
    loadState,
    error,
    reload,
  } = usePrFileContent({
    repoFullName,
    file: selectedFile,
    baseRef: baseSha,
    headRef: headSha,
  });

  const handleLineNumbersChange = useCallback(
    (enabled: boolean) => setLineNumbers(enabled ? "on" : "off"),
    [setLineNumbers]
  );

  if (loading && files.length === 0) {
    return (
      <Placeholder variant="loading" placement="sidebar" fillParentHeight />
    );
  }

  if (files.length === 0) {
    return (
      <Placeholder
        variant="empty"
        placement="sidebar"
        title={t("git.pr.changes.noFiles", "No file changes")}
        fillParentHeight
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1">
        {/* Left: file list (resizable) */}
        {!fileListCollapsed && (
          <>
            <div
              ref={setFileListElement}
              className="flex flex-shrink-0 flex-col overflow-hidden"
              style={{ width: `${fileListWidth}px` }}
            >
              <GitFileList
                files={gitFiles}
                unfilteredCountLabel={String(formatPrFilesCount(files.length))}
                selectedFileId={selectedFilePath}
                onFileSelect={updateSelectedFilePath}
              />
            </div>
            <VerticalResizeHandle onMouseDown={handleFileListResize} />
          </>
        )}
        {fileListCollapsed && (
          <button
            className="flex w-6 flex-shrink-0 items-center justify-center border-r border-border-2 hover:bg-fill-1"
            onClick={() => setFileListCollapsed(false)}
            title={t("tooltips.showFileList")}
          >
            <ChevronRight size={14} className="text-text-3" />
          </button>
        )}

        {/* Right: diff viewer */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {selectedFile ? (
            <>
              <FileHeader
                filePath={selectedFile.filename}
                repoPath={undefined}
                additions={selectedFile.additions}
                deletions={selectedFile.deletions}
                viewMode={viewMode}
                onViewModeChange={setViewMode}
                lineNumbersEnabled={lineNumbers !== "off"}
                onLineNumbersChange={handleLineNumbersChange}
                wordWrapEnabled={wordWrap}
                onWordWrapChange={setWordWrap}
                highlightActiveLineEnabled={highlightActiveLine}
                onHighlightActiveLineChange={setHighlightActiveLine}
                onMoreSettings={onOpenSettings}
                loading={loadState === "loading"}
                onFileSelect={onFileSelect}
              />
              <div className="relative min-h-0 flex-1">
                {loadState === "loading" ? (
                  <Placeholder
                    variant="loading"
                    placement="sidebar"
                    fillParentHeight
                  />
                ) : loadState === "error" ? (
                  <Placeholder
                    variant="error"
                    placement="sidebar"
                    title={t("placeholders.failedToLoad")}
                    subtitle={error ?? selectedFile.filename}
                    onRetry={reload}
                    fillParentHeight
                  />
                ) : truncated ? (
                  <Placeholder
                    variant="empty"
                    placement="sidebar"
                    title={t(
                      "git.pr.changes.tooLarge",
                      "File too large to diff"
                    )}
                    subtitle={selectedFile.filename}
                    fillParentHeight
                  />
                ) : isBinary ? (
                  <Placeholder
                    variant="empty"
                    placement="sidebar"
                    title={t("placeholders.unsupportedFileType")}
                    subtitle={t("placeholders.binaryUnsupportedEncoding")}
                    fillParentHeight
                  />
                ) : (
                  <CodeMirrorDiff
                    oldValue={oldContent}
                    newValue={newContent}
                    filePath={selectedFile.filename}
                    height="100%"
                    viewMode={viewMode}
                    readOnly={true}
                    mergeControls={false}
                    collapseUnchanged={true}
                  />
                )}
              </div>
            </>
          ) : (
            <Placeholder
              variant="empty"
              placement="sidebar"
              title={t("placeholders.selectFileToViewChanges")}
              fillParentHeight
            />
          )}
        </div>
      </div>

      <PrReviewThreadsPanel
        reviewComments={reviewComments}
        onReply={onReplyInlineComment}
      />
    </div>
  );
};

PrChangesTab.displayName = "PrChangesTab";
