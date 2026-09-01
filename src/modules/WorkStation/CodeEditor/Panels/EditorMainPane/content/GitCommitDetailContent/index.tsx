/**
 * GitCommitDetailContent Component
 *
 * Split layout for viewing a git commit's changes:
 * - Left panel: list of changed files
 * - Right panel: CodeMirror diff for the selected file
 *
 * Uses the existing getGitCommitDiff API to fetch commit details.
 */
import { useAtom, useAtomValue } from "jotai";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { gitFetchStream } from "@src/api/http/git/streaming";
import { Placeholder } from "@src/components/Placeholder";
import type { GitFileStatus } from "@src/config/gitStatus";
import { CodeMirrorDiff } from "@src/features/CodeMirror";
import { ArrowRight01Icon, HugeiconsIcon } from "@src/icons";
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
import { decodeOctalPath } from "@src/util/file/pathUtils";

import { CommitInfoPanel } from "./CommitInfoPanel";
import { CommitTabHeader } from "./CommitTabHeader";
import { useCommitDiffLoader } from "./useCommitDiffLoader";
import { useCommitFileDiffLoader } from "./useCommitFileDiffLoader";

interface GitCommitDetailContentProps {
  commitSha: string;
  shortSha: string;
  commitMessage: string;
  repoPath: string;
  repoId: string;
  isRepoReady?: boolean;
  onFileSelect?: (filePath: string) => void;
  headerVariant?: "commit" | "stash";
  headerRootLabel?: string;
  publishHeaderToWorkstation?: boolean;
  prNumber?: number;
}

const GitCommitDetailContent: React.FC<GitCommitDetailContentProps> = ({
  commitSha,
  shortSha,
  commitMessage,
  repoPath,
  repoId,
  isRepoReady = true,
  onFileSelect,
  headerVariant = "commit",
  headerRootLabel,
  publishHeaderToWorkstation = true,
  prNumber,
}) => {
  const { t } = useTranslation();

  const [fileListCollapsed, setFileListCollapsed] = useState(false);
  const [viewMode, setViewMode] = useAtom(diffViewModeAtom);
  const [lineNumbers, setLineNumbers] = useAtom(editorLineNumbersAtom);
  const [wordWrap, setWordWrap] = useAtom(editorWordWrapAtom);
  const [highlightActiveLine, setHighlightActiveLine] = useAtom(
    editorHighlightActiveLineAtom
  );
  const { onOpenSettings } = useAtomValue(activeStatusBarCallbacksAtom);
  const [fileListWidth, setFileListWidth] = useAtom(gitFileListWidthAtom);
  const [fetchingPrCommit, setFetchingPrCommit] = useState(false);
  const [fetchPrError, setFetchPrError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [fetchedPrCommitKey, setFetchedPrCommitKey] = useState<string | null>(
    null
  );
  const autoFetchAttemptRef = useRef<string | null>(null);
  const prCommitFetchKey = `${repoId}:${repoPath}:${prNumber ?? ""}:${commitSha}`;
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

  const {
    commitDiff,
    commitLoadState,
    commitError,
    selectedFilePath,
    setSelectedFilePath,
    reloadCommit,
  } = useCommitDiffLoader({
    commitSha,
    repoId,
    repoPath,
    isRepoReady,
    treatEmptyResultAsMissing: Boolean(prNumber),
  });

  const {
    fileOldContent,
    fileNewContent,
    selectedFileIsBinary,
    fileLoadState,
    fileError,
    reloadFile,
  } = useCommitFileDiffLoader({
    commitSha,
    repoId,
    repoPath,
    isRepoReady,
    selectedFilePath,
    commitDiff,
  });

  const selectedFile = useMemo(() => {
    if (!commitDiff || !selectedFilePath) return null;
    return (
      (commitDiff.files ?? []).find(
        (file) => decodeOctalPath(file.file_path) === selectedFilePath
      ) ?? null
    );
  }, [commitDiff, selectedFilePath]);

  const selectedFileMissingFromCommit = Boolean(
    selectedFilePath && commitDiff && !selectedFile
  );

  const gitFiles: GitFile[] = useMemo(() => {
    if (!commitDiff?.files) return [];
    return commitDiff.files.map((file) => ({
      id: decodeOctalPath(file.file_path),
      path: decodeOctalPath(file.file_path),
      status: (file.status || "modified") as GitFileStatus,
      additions: file.insertions ?? 0,
      deletions: file.deletions ?? 0,
      staged: true,
    }));
  }, [commitDiff]);

  const handleFileSelect = useCallback(
    (fileId: string) => {
      setSelectedFilePath(fileId);
    },
    [setSelectedFilePath]
  );

  const toggleFileList = useCallback(() => {
    setFileListCollapsed((prev) => !prev);
  }, []);

  const handleLineNumbersChange = useCallback(
    (enabled: boolean) => {
      setLineNumbers(enabled ? "on" : "off");
    },
    [setLineNumbers]
  );

  const handleFetchPrCommit = useCallback(() => {
    if (!prNumber || !repoId || !repoPath || fetchingPrCommit) return;

    setFetchingPrCommit(true);
    setFetchPrError(null);
    void gitFetchStream(
      {
        repo_id: repoId,
        repo_path: repoPath,
        remote: "origin",
        prune: false,
        refspec: `pull/${prNumber}/head:refs/orgii/pr/${prNumber}`,
      },
      {
        onComplete: (success) => {
          if (success) {
            setFetchedPrCommitKey(prCommitFetchKey);
            setFetchingPrCommit(false);
            reloadCommit();
          } else {
            setFetchingPrCommit(false);
            setFetchPrError({
              key: prCommitFetchKey,
              message: `git fetch origin pull/${prNumber}/head`,
            });
          }
        },
        onError: (error) => {
          setFetchingPrCommit(false);
          setFetchPrError({ key: prCommitFetchKey, message: error });
        },
      }
    );
  }, [
    fetchingPrCommit,
    prCommitFetchKey,
    prNumber,
    reloadCommit,
    repoId,
    repoPath,
  ]);

  useEffect(() => {
    if (
      !isRepoReady ||
      !prNumber ||
      commitLoadState !== "missing" ||
      autoFetchAttemptRef.current === prCommitFetchKey ||
      fetchingPrCommit
    ) {
      return;
    }

    const autoFetchTimer = window.setTimeout(() => {
      autoFetchAttemptRef.current = prCommitFetchKey;
      handleFetchPrCommit();
    }, 0);

    return () => window.clearTimeout(autoFetchTimer);
  }, [
    commitLoadState,
    fetchingPrCommit,
    handleFetchPrCommit,
    isRepoReady,
    prCommitFetchKey,
    prNumber,
  ]);

  const currentFetchPrError =
    fetchPrError?.key === prCommitFetchKey ? fetchPrError.message : null;

  const stashHeaderPath = `${headerRootLabel ?? shortSha}/${commitMessage}`;

  const hasInlineHeaderAbove = !publishHeaderToWorkstation;

  const stashHeaderPublisher =
    headerVariant === "stash" ? (
      <FileHeader
        filePath={stashHeaderPath}
        repoPath={undefined}
        useFileTypeIcon={false}
        disableNavigation
        publishToHost={publishHeaderToWorkstation ? "code" : undefined}
      />
    ) : null;

  if (!isRepoReady) {
    return (
      <>
        {stashHeaderPublisher}
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("placeholders.noRepoSelected")}
          subtitle={t("placeholders.selectRepositoryFromWorkspace")}
          fillParentHeight
        />
      </>
    );
  }

  const isReady = commitLoadState === "ready" && commitDiff;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <CommitTabHeader
        shortSha={shortSha}
        commitMessage={commitMessage}
        commitDiff={commitDiff}
        publishToWorkstationHeader={
          publishHeaderToWorkstation && headerVariant === "commit"
        }
      />
      {stashHeaderPublisher}
      {commitLoadState === "loading" ? (
        <Placeholder
          variant="loading"
          placement="detail-panel"
          fillParentHeight
        />
      ) : commitLoadState === "error" ? (
        <Placeholder
          variant="error"
          placement="detail-panel"
          title={t("placeholders.failedToLoadCommitDiff")}
          subtitle={commitError ?? commitSha}
          onRetry={reloadCommit}
          fillParentHeight
        />
      ) : commitLoadState === "missing" ? (
        fetchingPrCommit ||
        (prNumber &&
          !currentFetchPrError &&
          fetchedPrCommitKey !== prCommitFetchKey) ? (
          <Placeholder
            variant="loading"
            placement="detail-panel"
            fillParentHeight
          />
        ) : (
          <Placeholder
            variant="error"
            placement="detail-panel"
            title={t("placeholders.failedToLoadCommitDiff")}
            subtitle={currentFetchPrError ?? commitError ?? commitSha}
            onRetry={prNumber ? handleFetchPrCommit : reloadCommit}
            fillParentHeight
          />
        )
      ) : commitLoadState === "no-files" ? (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("placeholders.noChanges")}
          subtitle={shortSha}
          fillParentHeight
        />
      ) : !isReady ? (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("placeholders.noCommitData")}
          fillParentHeight
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <CommitInfoPanel
            commitDiff={commitDiff}
            hasInlineHeaderAbove={hasInlineHeaderAbove}
          />
          <div className="flex min-h-0 flex-1">
            {/* Left: File list panel (resizable, like a sidebar) — the right
              edge is drawn by `VerticalResizeHandle` (1px `bg-border-2`),
              so the column itself must NOT add its own right border. */}
            {!fileListCollapsed && (
              <>
                <div
                  ref={setFileListElement}
                  className="flex shrink-0 flex-col overflow-hidden"
                  style={{ width: `${fileListWidth}px` }}
                >
                  <GitFileList
                    files={gitFiles}
                    selectedFileId={selectedFilePath}
                    onFileSelect={handleFileSelect}
                  />
                </div>
                <VerticalResizeHandle onMouseDown={handleFileListResize} />
              </>
            )}

            {fileListCollapsed && (
              <button
                className="flex w-6 shrink-0 items-center justify-center border-r border-border-2 hover:bg-fill-1"
                onClick={toggleFileList}
                title={t("tooltips.showFileList")}
              >
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  data-icon="chevron-right"
                  size={14}
                  className="text-text-3"
                />
              </button>
            )}

            {/* Right: Diff viewer */}
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              {selectedFileMissingFromCommit ? (
                <Placeholder
                  variant="error"
                  placement="detail-panel"
                  title={t("placeholders.editorCouldNotOpenFileMissing")}
                  subtitle={`file=${selectedFilePath}, commit=${commitSha}`}
                  fillParentHeight
                />
              ) : selectedFile ? (
                <>
                  <FileHeader
                    filePath={selectedFile.file_path}
                    repoPath={repoPath}
                    additions={selectedFile.insertions}
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
                    loading={fileLoadState === "loading"}
                    onFileSelect={onFileSelect}
                  />

                  <div className="relative min-h-0 flex-1">
                    {fileLoadState === "loading" ? (
                      <Placeholder
                        variant="loading"
                        placement="detail-panel"
                        fillParentHeight
                      />
                    ) : fileLoadState === "error" ? (
                      <Placeholder
                        variant="error"
                        placement="detail-panel"
                        title={t("placeholders.failedToLoad")}
                        subtitle={fileError ?? selectedFile.file_path}
                        onRetry={reloadFile}
                        fillParentHeight
                      />
                    ) : selectedFileIsBinary ? (
                      <Placeholder
                        variant="empty"
                        placement="detail-panel"
                        title={t("placeholders.unsupportedFileType")}
                        subtitle={t("placeholders.binaryUnsupportedEncoding")}
                        fillParentHeight
                      />
                    ) : (
                      <CodeMirrorDiff
                        oldValue={fileOldContent}
                        newValue={fileNewContent}
                        filePath={selectedFile.file_path}
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
                  placement="detail-panel"
                  title={t("placeholders.selectFileToViewChanges")}
                  fillParentHeight
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default memo(GitCommitDetailContent);
