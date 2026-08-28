/**
 * EditorStatusBarLeft
 *
 * Left cluster of the CodeEditor status bar: workspace/repo, worktree,
 * branch + working diff, CI, git sync, session-repo hint, ports and the
 * indexing indicator. Presentational only — every value is passed in.
 */
import type { TFunction } from "i18next";
import type { ExtractAtomValue } from "jotai";
import React from "react";

import DiffStatsBadge from "@src/components/DiffStatsBadge";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import {
  ArrowLeftRightIcon,
  CodeIcon,
  FolderClosedIcon,
  FolderLibraryIcon,
  FolderTreeIcon,
  HugeiconsIcon,
  Loading03Icon,
  WorkflowCircle05Icon,
} from "@src/icons";
import type { sessionRepoHintAtom } from "@src/store/repo";
import type { ActiveWorktreeSelection } from "@src/store/workspace";
import type { IndexingProgress } from "@src/store/workstation/codeEditor/search/indexingProgressAtom";

import { CiStatusMenu } from "../CiStatusMenu";
import GitSyncStatusMenu from "../GitSyncStatusMenu";
import { PortsStatusMenu } from "../PortsStatusMenu";
import {
  StatusBarButton,
  StatusBarLabel,
  StatusBarSegment,
} from "../StatusBarBase";
import { StatusBarTooltip } from "../StatusBarTooltip";

export type SessionRepoHint = ExtractAtomValue<typeof sessionRepoHintAtom>;

export interface EditorStatusBarLeftProps {
  t: TFunction;
  repoName: string | undefined;
  branchName: string | undefined;
  isGitInitialized: boolean | null | undefined;
  showGitControls: boolean;
  checkoutLoading: boolean;
  isMultiRoot: boolean;
  workspaceLabel: string | undefined;
  activeWorktree: ActiveWorktreeSelection | null;
  aheadCount: number;
  behindCount: number;
  workingAdditions: number;
  workingDeletions: number;
  needsPublish: boolean;
  isSyncBusy: boolean;
  isPublishing: boolean;
  canSyncDisplayedRepo: boolean;
  syncSpinClass: string | undefined;
  syncStatusLabel: string | null;
  commitShortSha: string | undefined;
  sessionRepoHint: SessionRepoHint;
  showIndexingIndicator: boolean;
  isIndexingActive: boolean;
  indexingProgress: IndexingProgress;
  onRepoClick?: () => void;
  onBranchClick?: () => void;
  onWorktreeClick?: () => void;
  onSyncClick: () => void;
  onFetchClick: () => Promise<void>;
  onPullClick: () => Promise<void>;
  onRebaseClick: () => Promise<void>;
  onPushClick: () => Promise<void>;
  onSwitchToSessionRepo: () => void;
}

export const EditorStatusBarLeft: React.FC<EditorStatusBarLeftProps> = ({
  t,
  repoName,
  branchName,
  isGitInitialized,
  showGitControls,
  checkoutLoading,
  isMultiRoot,
  workspaceLabel,
  activeWorktree,
  aheadCount,
  behindCount,
  workingAdditions,
  workingDeletions,
  needsPublish,
  isSyncBusy,
  isPublishing,
  canSyncDisplayedRepo,
  syncSpinClass,
  syncStatusLabel,
  commitShortSha,
  sessionRepoHint,
  showIndexingIndicator,
  isIndexingActive,
  indexingProgress,
  onRepoClick,
  onBranchClick,
  onWorktreeClick,
  onSyncClick,
  onFetchClick,
  onPullClick,
  onRebaseClick,
  onPushClick,
  onSwitchToSessionRepo,
}) => (
  <>
    {repoName ? (
      <StatusBarTooltip
        label={t("workstation.switchWorkspaceTooltip", "Switch workspace")}
      >
        <StatusBarButton
          onClick={onRepoClick}
          ariaLabel={t(
            "workstation.switchWorkspaceTooltip",
            "Switch workspace"
          )}
          className="min-w-0 max-w-48"
          dataTestId="status-bar-repo-name"
        >
          {isMultiRoot ? (
            <HugeiconsIcon
              icon={FolderLibraryIcon}
              data-icon="folder-library"
              size={13}
              className="shrink-0 text-text-1"
            />
          ) : (
            <HugeiconsIcon
              icon={isGitInitialized === false ? FolderClosedIcon : CodeIcon}
              data-icon={isGitInitialized === false ? "folder" : "code"}
              size={13}
              className="shrink-0 text-text-1"
            />
          )}
          <StatusBarLabel emphasis className="min-w-0 truncate text-text-1">
            {workspaceLabel}
          </StatusBarLabel>
        </StatusBarButton>
      </StatusBarTooltip>
    ) : (
      <StatusBarButton
        onClick={onRepoClick}
        title={t("actions.openWorkspace")}
        dataTestId="status-bar-no-repo"
      >
        <HugeiconsIcon
          icon={CodeIcon}
          data-icon="code"
          size={13}
          className="text-primary-6"
        />
        <StatusBarLabel emphasis className="text-primary-6">
          {t("actions.addWorkspace")}
        </StatusBarLabel>
      </StatusBarButton>
    )}

    {repoName && isGitInitialized === false && (
      <StatusBarSegment
        className="text-text-2"
        title={t("workstation.notGitInitializedTooltip")}
      >
        <HugeiconsIcon
          icon={WorkflowCircle05Icon}
          data-icon="git-branch"
          size={13}
          className="text-text-2"
        />
        <StatusBarLabel emphasis className="text-text-2">
          {t("workstation.notGitInitialized")}
        </StatusBarLabel>
      </StatusBarSegment>
    )}

    {showGitControls && branchName && (
      <StatusBarTooltip
        label={t("workstation.switchWorktreeTooltip", "Switch worktree")}
      >
        <StatusBarButton
          onClick={onWorktreeClick}
          ariaLabel={t("workstation.switchWorktreeTooltip", "Switch worktree")}
          className="min-w-0 max-w-56"
          dataTestId="status-bar-worktree"
        >
          <HugeiconsIcon
            icon={FolderClosedIcon}
            data-icon="folder"
            size={13}
            className="shrink-0 text-text-1"
          />
          <StatusBarLabel emphasis className="min-w-0 truncate text-text-1">
            {activeWorktree && !activeWorktree.isMain
              ? activeWorktree.path.split("/").pop() ||
                activeWorktree.branch ||
                activeWorktree.path
              : t("selectors.branch.labels.mainWorktree", "Main")}
          </StatusBarLabel>
        </StatusBarButton>
      </StatusBarTooltip>
    )}

    {showGitControls && branchName && (
      <StatusBarTooltip
        label={
          checkoutLoading
            ? t("workstation.branchTooltipSwitching", {
                branch: branchName,
              })
            : t("workstation.switchBranchTooltip", "Switch branch")
        }
      >
        <StatusBarButton
          onClick={onBranchClick}
          className="min-w-0 max-w-64"
          dataTestId="status-bar-branch"
          ariaLabel={
            checkoutLoading
              ? t("workstation.branchTooltipSwitching", {
                  branch: branchName,
                })
              : t("workstation.switchBranchTooltip", "Switch branch")
          }
        >
          {checkoutLoading ? (
            <HugeiconsIcon
              icon={Loading03Icon}
              data-icon="loader-2"
              size={SPINNER_TOKENS.small}
              className="shrink-0 animate-spin text-text-1"
            />
          ) : (
            <HugeiconsIcon
              icon={WorkflowCircle05Icon}
              data-icon="git-branch"
              size={13}
              className="shrink-0 text-text-1"
            />
          )}
          <StatusBarLabel emphasis className="min-w-0 truncate text-text-1">
            {branchName}
          </StatusBarLabel>
          {(workingAdditions > 0 || workingDeletions > 0) && (
            <DiffStatsBadge
              additions={workingAdditions}
              deletions={workingDeletions}
              variant="plain"
              size="xs"
              weight="normal"
              reserveValueWidth={false}
              className="shrink-0"
            />
          )}
        </StatusBarButton>
      </StatusBarTooltip>
    )}

    {showGitControls && branchName && (
      <CiStatusMenu branchName={branchName} headRevision={commitShortSha} />
    )}

    {showGitControls && branchName && (
      <GitSyncStatusMenu
        aheadCount={aheadCount}
        behindCount={behindCount}
        needsPublish={needsPublish}
        isSyncBusy={isSyncBusy}
        isPublishing={isPublishing}
        canSyncDisplayedRepo={canSyncDisplayedRepo}
        syncSpinClass={syncSpinClass}
        syncStatusLabel={syncStatusLabel}
        onSync={onSyncClick}
        onFetch={onFetchClick}
        onPull={onPullClick}
        onRebase={onRebaseClick}
        onPush={onPushClick}
      />
    )}

    {sessionRepoHint && (
      <StatusBarButton
        onClick={onSwitchToSessionRepo}
        title={t("workstation.switchToSessionRepo", {
          name:
            sessionRepoHint.type === "folder"
              ? sessionRepoHint.folderName
              : sessionRepoHint.repoName,
        })}
        className="pl-2 text-primary-6"
        dataTestId="status-bar-switch-to-session-repo"
      >
        <HugeiconsIcon
          icon={ArrowLeftRightIcon}
          data-icon="arrow-right-left"
          size={13}
        />
        <StatusBarLabel emphasis>
          {t("workstation.switchToSessionRepo", {
            name:
              sessionRepoHint.type === "folder"
                ? sessionRepoHint.folderName
                : sessionRepoHint.repoName,
          })}
        </StatusBarLabel>
      </StatusBarButton>
    )}

    <PortsStatusMenu />

    {showIndexingIndicator && (
      <StatusBarSegment
        className="text-text-1"
        title={
          indexingProgress.status === "embedding"
            ? indexingProgress.progress > 0
              ? t("workstation.embeddingProgressWithPercent", {
                  count: indexingProgress.chunksEmbedded,
                  percent: indexingProgress.progress,
                })
              : t("workstation.embeddingProgress", {
                  count: indexingProgress.chunksEmbedded,
                })
            : indexingProgress.filesTotal > 0
              ? indexingProgress.currentFile
                ? t("workstation.indexingProgressWithFile", {
                    processed: indexingProgress.filesProcessed,
                    total: indexingProgress.filesTotal,
                    percent: indexingProgress.progress,
                    file: indexingProgress.currentFile,
                  })
                : t("workstation.indexingProgress", {
                    processed: indexingProgress.filesProcessed,
                    total: indexingProgress.filesTotal,
                    percent: indexingProgress.progress,
                  })
              : t("workstation.scanningFiles")
        }
      >
        <HugeiconsIcon
          icon={FolderTreeIcon}
          data-icon="folder-tree"
          size={13}
          className={isIndexingActive ? "animate-pulse" : ""}
        />
        <StatusBarLabel emphasis>
          {indexingProgress.status === "embedding"
            ? indexingProgress.progress > 0
              ? t("workstation.embeddingShort", {
                  percent: indexingProgress.progress,
                })
              : `${t("workstation.embeddingLabel")}...`
            : indexingProgress.filesTotal > 0
              ? `${t("labels.indexing")} ${indexingProgress.filesProcessed}/${indexingProgress.filesTotal}`
              : `${t("labels.indexing")}...`}
        </StatusBarLabel>
      </StatusBarSegment>
    )}
  </>
);

EditorStatusBarLeft.displayName = "EditorStatusBarLeft";
