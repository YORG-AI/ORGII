import { useAtomValue, useSetAtom } from "jotai";
import { Check, Loader2, X } from "lucide-react";
import React, { memo, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { useRepoGitInitialization } from "@src/hooks/git";
import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { currentBranchAtom, sessionRepoHintAtom } from "@src/store/repo";
import { useOverlayLayer } from "@src/store/ui/overlayLayerAtom";
import { activeFolderIdAtom } from "@src/store/workspace";
import {
  activeWorkspaceRootNameAtom,
  activeWorkspaceRootPathAtom,
  activeWorktreeAtom,
} from "@src/store/workspace";
import { diagnosticHealthAtom } from "@src/store/workstation/codeEditor/diagnostics";
import {
  indexingProgressAtom,
  isIndexingAtom,
} from "@src/store/workstation/codeEditor/search/indexingProgressAtom";

import { BaseStatusBar } from "./StatusBarBase";
import { EditorStatusBarLeft } from "./components/EditorStatusBarLeft";
import { EditorStatusBarRight } from "./components/EditorStatusBarRight";
import type { EditorStatusBarProps } from "./types";
import { buildLanguageServicePanelRows } from "./utils/languageServicePanelRows";
import {
  countActiveLanguageServiceSources,
  getLanguageFromPath,
} from "./utils/statusBarUtils";
import { useEditorStatusBarGit } from "./utils/useEditorStatusBarGit";
import { useIndexingIndicator } from "./utils/useIndexingIndicator";
import { useLspDropdown } from "./utils/useLspDropdown";

export type {
  CommitInfo,
  CursorPosition,
  EditorStatusBarProps,
  LspStatus,
} from "./types";

export const EditorStatusBar: React.FC<EditorStatusBarProps> = memo(
  ({
    cursor,
    filePath,
    totalLines,
    commitInfo,
    lspStatus,
    onRepoClick,
    onBranchClick,
    onWorktreeClick,
    className = "",
  }) => {
    const { t } = useTranslation();
    const language = getLanguageFromPath(filePath);
    const hasSelection = cursor?.selectedChars && cursor.selectedChars > 0;

    // Workspace and branch identity are read straight from the global
    // workspace/repo atoms, never pushed in by a content host: the status bar
    // outlives the Code Editor, which unmounts on the empty Launchpad
    // (`hostMountPolicy.ts`). Only genuinely file-scoped values (cursor, path,
    // LSP, commit tab) arrive as props.
    const repoPath = useAtomValue(activeWorkspaceRootPathAtom);
    const repoName = useAtomValue(activeWorkspaceRootNameAtom) || undefined;
    const branchName = useAtomValue(currentBranchAtom) || undefined;
    const activeWorktree = useAtomValue(activeWorktreeAtom);

    const {
      workspaceLabel,
      isMultiRoot,
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
      handleSyncClick,
      handleFetchClick,
      handlePullClick,
      handleRebaseClick,
      handlePushClick,
      checkoutLoading,
    } = useEditorStatusBarGit({ repoName, repoPath, branchName });

    const { isGitInitialized } = useRepoGitInitialization(repoPath);

    const sessionRepoHint = useAtomValue(sessionRepoHintAtom);
    const setActiveFolderId = useSetAtom(activeFolderIdAtom);
    const { selectRepo } = useRepoSelection({ autoLoad: false });
    const handleSwitchToSessionRepo = useCallback(() => {
      if (!sessionRepoHint) return;
      if (sessionRepoHint.type === "folder") {
        setActiveFolderId(sessionRepoHint.folderId);
        return;
      }
      selectRepo(sessionRepoHint.repoId);
    }, [sessionRepoHint, selectRepo, setActiveFolderId]);
    const showGitControls = isGitInitialized === true;

    const diagnosticHealth = useAtomValue(diagnosticHealthAtom);
    const activeLanguageServiceCount = useMemo(
      () => countActiveLanguageServiceSources(diagnosticHealth),
      [diagnosticHealth]
    );

    const {
      lspDropdownOpen,
      lspButtonRef,
      lspDropdownPosition,
      handleToggleLspDropdown,
      handleCloseLspDropdown,
    } = useLspDropdown();
    const lspDropdownRef = useRef<HTMLDivElement | null>(null);
    useOverlayLayer(lspDropdownOpen, lspDropdownRef);

    const isIndexingActive = useAtomValue(isIndexingAtom);
    const indexingProgress = useAtomValue(indexingProgressAtom);

    const showIndexingIndicator = useIndexingIndicator(isIndexingActive);

    const leftContent = useMemo(
      () => (
        <EditorStatusBarLeft
          t={t}
          repoName={repoName}
          branchName={branchName}
          isGitInitialized={isGitInitialized}
          showGitControls={showGitControls}
          checkoutLoading={checkoutLoading}
          isMultiRoot={isMultiRoot}
          workspaceLabel={workspaceLabel}
          activeWorktree={activeWorktree}
          aheadCount={aheadCount}
          behindCount={behindCount}
          workingAdditions={workingAdditions}
          workingDeletions={workingDeletions}
          needsPublish={needsPublish}
          isSyncBusy={isSyncBusy}
          isPublishing={isPublishing}
          canSyncDisplayedRepo={canSyncDisplayedRepo}
          syncSpinClass={syncSpinClass}
          syncStatusLabel={syncStatusLabel}
          commitShortSha={commitInfo?.shortSha}
          sessionRepoHint={sessionRepoHint}
          showIndexingIndicator={showIndexingIndicator}
          isIndexingActive={isIndexingActive}
          indexingProgress={indexingProgress}
          onRepoClick={onRepoClick}
          onBranchClick={onBranchClick}
          onWorktreeClick={onWorktreeClick}
          onSyncClick={handleSyncClick}
          onFetchClick={handleFetchClick}
          onPullClick={handlePullClick}
          onRebaseClick={handleRebaseClick}
          onPushClick={handlePushClick}
          onSwitchToSessionRepo={handleSwitchToSessionRepo}
        />
      ),
      [
        repoName,
        branchName,
        isGitInitialized,
        showGitControls,
        checkoutLoading,
        needsPublish,
        isSyncBusy,
        isPublishing,
        canSyncDisplayedRepo,
        behindCount,
        aheadCount,
        workingAdditions,
        workingDeletions,
        commitInfo?.shortSha,
        onRepoClick,
        onBranchClick,
        onWorktreeClick,
        activeWorktree,
        handleSyncClick,
        handleFetchClick,
        handlePullClick,
        handleRebaseClick,
        handlePushClick,
        syncSpinClass,
        syncStatusLabel,
        showIndexingIndicator,
        isIndexingActive,
        indexingProgress,
        isMultiRoot,
        workspaceLabel,
        sessionRepoHint,
        handleSwitchToSessionRepo,
        t,
      ]
    );

    const rightContent = useMemo(
      () => (
        <EditorStatusBarRight
          t={t}
          commitInfo={commitInfo}
          cursor={cursor}
          hasSelection={hasSelection}
          totalLines={totalLines}
          filePath={filePath}
          language={language}
          lspStatus={lspStatus}
          lspButtonRef={lspButtonRef}
          lspDropdownOpen={lspDropdownOpen}
          hasActiveSource={diagnosticHealth.hasActiveSource}
          activeLanguageServiceCount={activeLanguageServiceCount}
          onToggleLspDropdown={handleToggleLspDropdown}
        />
      ),
      [
        t,
        commitInfo,
        cursor,
        hasSelection,
        totalLines,
        lspStatus,
        filePath,
        language,
        lspButtonRef,
        handleToggleLspDropdown,
        lspDropdownOpen,
        diagnosticHealth.hasActiveSource,
        activeLanguageServiceCount,
      ]
    );

    const languageServicePanelRows = useMemo(
      () => buildLanguageServicePanelRows(diagnosticHealth, t),
      [diagnosticHealth, t]
    );

    return (
      <>
        <BaseStatusBar
          leftContent={leftContent}
          rightContent={rightContent}
          roundedBottom={false}
          className={className}
        />

        {lspDropdownOpen &&
          lspDropdownPosition &&
          createPortal(
            <>
              <div
                className="fixed inset-0 z-[1049]"
                onClick={handleCloseLspDropdown}
              />
              <div
                ref={lspDropdownRef}
                className={`${DROPDOWN_CLASSES.panel} fixed p-3 ${DROPDOWN_WIDTHS.panelWidthClass}`}
                style={{
                  bottom: lspDropdownPosition.bottom,
                  right: lspDropdownPosition.right,
                }}
              >
                <div className={`space-y-2 ${DROPDOWN_ITEM.fontSizeClass}`}>
                  {languageServicePanelRows.map((row) =>
                    row.kind === "empty" ? (
                      <div key={row.key} className="font-bold text-text-3">
                        {row.message}
                      </div>
                    ) : (
                      <div
                        key={row.key}
                        className="flex items-center justify-between gap-3"
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          {row.uiStatus === "active" ? (
                            <Check
                              size={14}
                              className="shrink-0 text-green-500"
                            />
                          ) : row.uiStatus === "initializing" ? (
                            <Loader2
                              size={12}
                              className="shrink-0 animate-spin text-text-3"
                            />
                          ) : row.uiStatus === "failed" ? (
                            <X size={14} className="shrink-0 text-red-500" />
                          ) : (
                            <span className="w-3.5 shrink-0" aria-hidden />
                          )}
                          <span className="shrink-0 font-bold text-text-3">
                            {row.left}
                          </span>
                        </div>
                        <span className="min-w-0 shrink-0 text-right font-bold text-text-1">
                          {row.right}
                        </span>
                      </div>
                    )
                  )}
                </div>
              </div>
            </>,
            document.body
          )}
      </>
    );
  }
);

EditorStatusBar.displayName = "EditorStatusBar";

export default EditorStatusBar;
