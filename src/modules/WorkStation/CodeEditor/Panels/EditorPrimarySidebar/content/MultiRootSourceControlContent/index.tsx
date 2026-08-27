/**
 * MultiRootSourceControlContent
 *
 * Renders per-folder source control sections for multi-root workspaces.
 * Each workspace folder gets its own independent git status fetch via
 * usePerRepoSourceControl (HTTP API per repo), NOT the global
 * gitStatusAtom which only tracks the primary repo.
 *
 * PERFORMANCE: Each folder section only mounts its hook when expanded (lazy).
 */
import { useAtomValue } from "jotai";
import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { removeGitWorktree } from "@src/api/http/git";
import type { GitWorktreeEntry } from "@src/api/http/git/types";
import { Placeholder } from "@src/components/Placeholder";
import { FolderHeaderRow } from "@src/modules/WorkStation/shared/FolderHeaderRow";
import { FOLDER_HEADER } from "@src/modules/WorkStation/shared/tokens";
import { reposAtom } from "@src/store/repo";
import { activeFolderAtom } from "@src/store/workspace/derived";
import type { SourceControlHistorySelection } from "@src/store/workstation/tabs";
import type { GitFile } from "@src/types/git/types";
import type { WorkspaceFolder } from "@src/types/workspace";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";
import { showGitActionDialogSafely } from "@src/util/dialogs/gitActionDialog";

import {
  type UsePerRepoSourceControlResult,
  usePerRepoSourceControl,
} from "../../hooks/usePerRepoSourceControl";
import SourceControlContent from "../SourceControlContent";
import {
  WorktreeActionsMenu,
  WorktreeContextMenu,
} from "../WorktreeActionsMenu";
import { WorktreeSourceControlSection } from "../WorktreeSourceControlSection";

// ============================================
// Types
// ============================================

export interface MultiRootSourceControlContentProps {
  workspaceFolders: WorkspaceFolder[];
  repoId: string;
  repoPath: string;
  onGitFileSelect?: (file: GitFile) => void;
  onGitFilesChange?: (files: GitFile[], scopeRepoRoot: string) => void;
  onGitHistorySelectionChange?: (
    selection: SourceControlHistorySelection
  ) => void;
  showFilter: boolean;
  viewMode: "list-tree" | "list";
  worktrees?: GitWorktreeEntry[];
  onWorktreesRefresh?: () => Promise<void>;
  navigateWithoutSelecting?: boolean;
  /** Working-tree section filter forwarded to every per-folder pane. */
  sectionFilter?: "uncommitted" | "staged" | "unstaged";
}

export interface MultiRootSourceControlContentHandle {
  refresh: () => Promise<void>;
}

// ============================================
// Per-folder section header + lazy content
// ============================================

export interface FolderSectionHandle {
  refresh: () => Promise<void>;
}

function toAbsoluteFolderFile(file: GitFile, folderPath: string): GitFile {
  const absolutePath = file.path.startsWith("/")
    ? file.path
    : `${folderPath}/${file.path}`;
  return { ...file, path: absolutePath, repoRoot: folderPath };
}

function normalizeFsPath(path: string | undefined): string {
  if (!path) return "";
  const stripped = path.startsWith("file://")
    ? path.replace("file://", "")
    : path;
  return stripped.replace(/\/+$/, "");
}

async function confirmAndRemoveWorktree({
  repoId,
  repoPath,
  worktree,
  folderName,
  onRemoved,
  t,
}: {
  repoId: string;
  repoPath: string;
  worktree: GitWorktreeEntry;
  folderName: string;
  onRemoved?: () => Promise<void>;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const confirmed = await confirmDestructiveAction({
    title: t("sourceControl.removeWorktreeTitle", { name: folderName }),
    message: t("sourceControl.removeWorktreeMessage"),
    okLabel: t("sourceControl.removeWorktree"),
  });
  if (!confirmed) return;

  try {
    await removeGitWorktree({
      repo_id: repoId,
      repo_path: repoPath,
      worktree_path: worktree.path,
      force: true,
    });
    await onRemoved?.();
    showGitActionDialogSafely(t("sourceControl.removeWorktreeSuccess"), "info");
  } catch (error) {
    showGitActionDialogSafely(
      error instanceof Error
        ? error.message
        : t("sourceControl.removeWorktreeFailed"),
      "error"
    );
  }
}

interface FolderSectionProps {
  folder: WorkspaceFolder;
  onGitFileSelect?: (file: GitFile) => void;
  onGitFilesChange?: (files: GitFile[], scopeRepoRoot: string) => void;
  onGitHistorySelectionChange?: (
    selection: SourceControlHistorySelection
  ) => void;
  showFilter: boolean;
  viewMode: "list-tree" | "list";
  navigateWithoutSelecting?: boolean;
  defaultExpanded: boolean;
  isActive: boolean;
  sectionFilter?: "uncommitted" | "staged" | "unstaged";
}

const FolderSection = React.forwardRef<FolderSectionHandle, FolderSectionProps>(
  (
    {
      folder,
      onGitFileSelect,
      onGitFilesChange,
      onGitHistorySelectionChange,
      showFilter,
      viewMode,
      navigateWithoutSelecting,
      defaultExpanded,
      isActive,
      sectionFilter,
    },
    ref
  ) => {
    const [expanded, setExpanded] = useState(defaultExpanded || isActive);
    const [branchName, setBranchName] = useState<string | undefined>();
    const contentRef = useRef<FolderSectionContentHandle>(null);
    const [prevActive, setPrevActive] = useState(isActive);

    if (isActive !== prevActive) {
      setPrevActive(isActive);
      if (isActive && !expanded) {
        setExpanded(true);
      }
    }

    useImperativeHandle(
      ref,
      () => ({
        refresh: async () => {
          await contentRef.current?.refresh();
        },
      }),
      []
    );

    const toggle = useCallback(() => setExpanded((prev) => !prev), []);

    return (
      <div
        className={`${FOLDER_HEADER.section} flex flex-col ${
          expanded ? "min-h-0 flex-1 overflow-hidden" : "flex-shrink-0"
        }`}
      >
        <FolderHeaderRow
          name={folder.name}
          expanded={expanded}
          onToggle={toggle}
          branchName={branchName}
        />

        {expanded && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <FolderSectionContent
              ref={contentRef}
              folder={folder}
              onGitFileSelect={onGitFileSelect}
              onGitFilesChange={onGitFilesChange}
              onGitHistorySelectionChange={onGitHistorySelectionChange}
              showFilter={showFilter}
              viewMode={viewMode}
              navigateWithoutSelecting={navigateWithoutSelecting}
              onBranchChange={setBranchName}
              sectionFilter={sectionFilter}
            />
          </div>
        )}
      </div>
    );
  }
);

FolderSection.displayName = "FolderSection";

// ============================================
// Content wrapper (lazy mounts per-repo hook)
// ============================================

export interface FolderSectionContentHandle {
  refresh: () => Promise<void>;
}

interface FolderSectionContentProps {
  folder: WorkspaceFolder;
  onGitFileSelect?: (file: GitFile) => void;
  onGitFilesChange?: (files: GitFile[], scopeRepoRoot: string) => void;
  onGitHistorySelectionChange?: (
    selection: SourceControlHistorySelection
  ) => void;
  showFilter: boolean;
  viewMode: "list-tree" | "list";
  navigateWithoutSelecting?: boolean;
  onBranchChange?: (branch: string | undefined) => void;
  sectionFilter?: "uncommitted" | "staged" | "unstaged";
}

const FolderSectionContent = React.forwardRef<
  FolderSectionContentHandle,
  FolderSectionContentProps
>(
  (
    {
      folder,
      onGitFileSelect,
      onGitFilesChange,
      onGitHistorySelectionChange: _onGitHistorySelectionChange,
      showFilter,
      viewMode,
      navigateWithoutSelecting,
      onBranchChange,
      sectionFilter,
    },
    ref
  ) => {
    const handleGitFileSelect = useCallback(
      (file: GitFile) => {
        onGitFileSelect?.(toAbsoluteFolderFile(file, folder.path));
      },
      [folder.path, onGitFileSelect]
    );

    const { state, refresh, loading }: UsePerRepoSourceControlResult =
      usePerRepoSourceControl({
        repoPath: folder.path,
        repoId: folder.id,
        onGitFileSelect: handleGitFileSelect,
      });

    const absoluteFiles = useMemo(
      () => state.files.map((file) => toAbsoluteFolderFile(file, folder.path)),
      [folder.path, state.files]
    );

    useEffect(() => {
      onGitFilesChange?.(absoluteFiles, folder.path);
    }, [absoluteFiles, folder.path, onGitFilesChange]);

    useImperativeHandle(ref, () => ({ refresh }), [refresh]);

    // Report branch name to parent header
    useEffect(() => {
      onBranchChange?.(state.branchName);
    }, [state.branchName, onBranchChange]);

    const handleRefresh = useCallback(() => {
      refresh();
    }, [refresh]);

    const files = state.files;
    const selectFile = state.onFileSelect;

    const handleContentFileSelect = useCallback(
      (fileId: string) => {
        if (!navigateWithoutSelecting) {
          selectFile(fileId);
          return;
        }
        const file = files.find((candidate) => candidate.id === fileId);
        if (file) {
          handleGitFileSelect(file);
        }
      },
      [files, handleGitFileSelect, navigateWithoutSelecting, selectFile]
    );

    return (
      <SourceControlContent
        files={state.files}
        filteredFiles={state.filteredFiles}
        selectedFileId={navigateWithoutSelecting ? "" : state.selectedFileId}
        loading={loading}
        error={state.error}
        onFileSelect={handleContentFileSelect}
        onStageToggle={state.onStageToggle}
        onDiscard={state.onDiscard}
        onStageAll={state.onStageAll}
        onUnstageAll={state.onUnstageAll}
        onDiscardAll={state.onDiscardAll}
        commitMessage={state.commitMessage}
        onCommitMessageChange={state.onCommitMessageChange}
        onCommit={state.onCommit}
        commitLoading={state.commitLoading}
        generateCommitMessageLoading={state.generateCommitMessageLoading}
        onGenerateCommitMessage={state.onGenerateCommitMessage}
        stagedFilesCount={state.stagedFilesCount}
        branchName={state.branchName}
        searchQuery={state.searchQuery}
        onSearchChange={state.onSearchChange}
        showFilter={showFilter}
        viewMode={viewMode}
        sectionFilter={sectionFilter}
        navigateWithoutSelecting={navigateWithoutSelecting}
        onRefresh={handleRefresh}
        ahead={state.ahead}
        behind={state.behind}
        hasUpstream={state.hasUpstream}
        repoId={folder.id}
        repoPath={folder.path}
      />
    );
  }
);

FolderSectionContent.displayName = "FolderSectionContent";

// ============================================
// Worktree section (collapsible, lazy content)
// ============================================

interface WorktreeSectionProps {
  worktree: GitWorktreeEntry;
  repoId?: string;
  repoPath?: string;
  onWorktreesRefresh?: () => Promise<void>;
  onGitFileSelect?: (file: GitFile) => void;
  showFilter: boolean;
  viewMode: "list-tree" | "list";
  navigateWithoutSelecting?: boolean;
  sectionFilter?: "uncommitted" | "staged" | "unstaged";
}

const WorktreeSection: React.FC<WorktreeSectionProps> = ({
  worktree,
  repoId,
  repoPath,
  onWorktreesRefresh,
  onGitFileSelect,
  showFilter,
  viewMode,
  navigateWithoutSelecting,
  sectionFilter,
}) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const toggle = useCallback(() => setExpanded((prev) => !prev), []);

  const folderName = worktree.path.split("/").pop() || "worktree";

  const removeWorktree = useCallback(async () => {
    if (!repoId || !repoPath) return;
    await confirmAndRemoveWorktree({
      repoId,
      repoPath,
      worktree,
      folderName,
      onRemoved: onWorktreesRefresh,
      t,
    });
  }, [folderName, onWorktreesRefresh, repoId, repoPath, t, worktree]);

  return (
    <div className={FOLDER_HEADER.section}>
      <FolderHeaderRow
        name={folderName}
        expanded={expanded}
        onToggle={toggle}
        branchName={worktree.branch || undefined}
        onContextMenu={(event) => {
          if (!repoId || !repoPath) return;
          event.preventDefault();
          setContextMenuPosition({ x: event.clientX, y: event.clientY });
        }}
        actions={
          repoId && repoPath ? (
            <WorktreeActionsMenu
              onRemove={() => {
                void removeWorktree();
              }}
            />
          ) : null
        }
      />
      {expanded && repoId && (
        <div className="flex min-h-[280px] flex-col overflow-hidden">
          <WorktreeSourceControlSection
            worktreePath={worktree.path}
            hostRepoId={repoId}
            onGitFileSelect={onGitFileSelect}
            showFilter={showFilter}
            viewMode={viewMode}
            navigateWithoutSelecting={navigateWithoutSelecting}
            sectionFilter={sectionFilter}
          />
        </div>
      )}
      {contextMenuPosition && (
        <WorktreeContextMenu
          x={contextMenuPosition.x}
          y={contextMenuPosition.y}
          onRemove={() => {
            void removeWorktree();
          }}
          onClose={() => setContextMenuPosition(null)}
        />
      )}
    </div>
  );
};

WorktreeSection.displayName = "WorktreeSection";

// ============================================
// Main Component
// ============================================

export const MultiRootSourceControlContent = React.forwardRef<
  MultiRootSourceControlContentHandle,
  MultiRootSourceControlContentProps
>(
  (
    {
      workspaceFolders,
      repoId,
      repoPath,
      onGitFileSelect,
      onGitFilesChange,
      onGitHistorySelectionChange,
      showFilter,
      viewMode,
      worktrees = [],
      onWorktreesRefresh,
      navigateWithoutSelecting,
      sectionFilter,
    },
    ref
  ) => {
    const repos = useAtomValue(reposAtom);
    const folderList = useMemo(() => {
      const repoNameById = new Map<string, string>(
        repos.map((repo) => [repo.id, String(repo.name ?? "")])
      );
      const repoNameByPath = new Map<string, string>(
        repos
          .map((repo): [string, string] => [
            normalizeFsPath(repo.fs_uri ?? repo.path),
            String(repo.name ?? ""),
          ])
          .filter(([path]) => Boolean(path))
      );

      return workspaceFolders
        .filter((folder) => folder.path)
        .map((folder) => {
          const repoName = folder.repoId
            ? repoNameById.get(folder.repoId)
            : undefined;
          const pathName = repoNameByPath.get(normalizeFsPath(folder.path));
          return { ...folder, name: repoName ?? pathName ?? folder.name };
        });
    }, [repos, workspaceFolders]);

    const activeFolder = useAtomValue(activeFolderAtom);

    // Track child handles via callback refs (avoids ref-during-render lint)
    const [handlesMap] = useState(() => new Map<string, FolderSectionHandle>());

    const makeCallbackRef = useCallback(
      (folderId: string) => (node: FolderSectionHandle | null) => {
        if (node) {
          handlesMap.set(folderId, node);
        } else {
          handlesMap.delete(folderId);
        }
      },
      [handlesMap]
    );

    useImperativeHandle(
      ref,
      () => ({
        refresh: async () => {
          const promises: Promise<void>[] = [];
          for (const handle of handlesMap.values()) {
            promises.push(handle.refresh());
          }
          await Promise.all(promises);
        },
      }),
      [handlesMap]
    );

    const { t: tMain } = useTranslation();

    if (folderList.length === 0) {
      return (
        <Placeholder
          variant="empty"
          placement="sidebar"
          title={tMain("placeholders.noWorkspaceFolders")}
          fillParentHeight
        />
      );
    }

    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {folderList.map((folder, index) => (
          <FolderSection
            key={folder.id}
            ref={makeCallbackRef(folder.id)}
            folder={folder}
            onGitFileSelect={onGitFileSelect}
            onGitFilesChange={onGitFilesChange}
            onGitHistorySelectionChange={onGitHistorySelectionChange}
            showFilter={showFilter}
            viewMode={viewMode}
            navigateWithoutSelecting={navigateWithoutSelecting}
            defaultExpanded={index < 3}
            isActive={folder.id === activeFolder?.id}
            sectionFilter={sectionFilter}
          />
        ))}
        {worktrees.map((worktree) => (
          <WorktreeSection
            key={worktree.path}
            worktree={worktree}
            repoId={repoId}
            repoPath={repoPath}
            onWorktreesRefresh={onWorktreesRefresh}
            onGitFileSelect={onGitFileSelect}
            showFilter={showFilter}
            viewMode={viewMode}
            navigateWithoutSelecting={navigateWithoutSelecting}
            sectionFilter={sectionFilter}
          />
        ))}
      </div>
    );
  }
);

MultiRootSourceControlContent.displayName = "MultiRootSourceControlContent";

export default MultiRootSourceControlContent;
