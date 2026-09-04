/**
 * SourceControlContent Component
 *
 * Source Control panel with virtualized file tree.
 *
 * Features:
 * - Commit message input at top
 * - Virtualized tree with section headers (Merge, Staged, Changes)
 * - Stash management
 * - Multi-select support
 */
import React, {
  memo,
  useCallback,
  useDeferredValue,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Input from "@src/components/Input";
import { Placeholder } from "@src/components/Placeholder";
import { TREE_ROW_HEIGHT } from "@src/components/TreeRow";
import type {
  FlattenedTreeNode,
  StickyScrollNode,
} from "@src/components/VirtualizedStickyTree";
import { VirtualizedStickyTree } from "@src/components/VirtualizedStickyTree";
import { FilterIcon, HugeiconsIcon } from "@src/icons";
import { usePrimarySidebarSurface } from "@src/modules/WorkStation/shared/hooks/usePrimarySidebarSurface";

import { useFileSelection } from "../../hooks/useFileSelection";
import { useSourceControlShortcuts } from "../../hooks/useSourceControlShortcuts";
import { CommitSection } from "./components";
import { SourceControlStickyHeader } from "./components/SourceControlStickyHeader";
import SourceControlTreeRow from "./components/SourceControlTreeRow";
import { GIT_LABELS } from "./config";
import {
  useBulkOperations,
  useCommitLogic,
  useFileTreeHandling,
} from "./hooks";
import type { SourceControlContentProps } from "./types";
import {
  type SourceControlNode,
  flattenSourceControlTree,
} from "./utils/virtualizedTreeUtils";

export type { SourceControlContentProps } from "./types";

const StashContent = React.lazy(() => import("../StashContent"));

// Section header row height matches file row height (28px)

export const SourceControlContent: React.FC<SourceControlContentProps> = memo(
  ({
    files,
    filteredFiles,
    selectedFileId,
    loading,
    error,
    onFileSelect,
    navigateWithoutSelecting = false,
    onStageToggle,
    onDiscard,
    onDiscardFiles,
    onStageAll,
    onUnstageAll,
    onDiscardAll,
    onOpenStagedChanges,
    commitMessage,
    onCommitMessageChange,
    onCommit,
    onCommitAndPush,
    onCommitAndPublish,
    onCommitAndSync,
    onAmend,
    commitLoading,
    stagedFilesCount,
    branchName,
    onGenerateCommitMessage,
    generateCommitMessageLoading = false,
    searchQuery,
    onSearchChange,
    showFilter = false,
    viewMode = "list-tree",
    showOnlyStashes = false,
    sectionFilter = "uncommitted",
    // Merge conflict props
    conflictFiles = [],
    hasConflicts = false,
    onStageResolved,
    // Merge operation props
    isMerging = false,
    mergingBranch,
    onContinueMerge,
    // Stash management props
    stashes = [],
    stashOperationLoading = false,
    hasChangesToStash = false,
    onStashPush,
    onStashApply,
    onStashPop,
    onStashDrop,
    onHistorySelectionChange,
    // Refresh callback
    onRefresh,
    // Sync props
    ahead = 0,
    behind = 0,
    onSync,
    syncLoading = false,
    onPull,
    pullLoading = false,
    onPush,
    pushLoading = false,
    onFetch,
    fetchLoading = false,
    // Publish props
    hasUpstream = true,
    onPublish,
    publishLoading = false,
    // Repo identification
    repoPath,
    // Layout
    stickyBgClass,
    suppressLoadingPlaceholder = false,
  }) => {
    const { t } = useTranslation();
    const { surfaceBgClass, stickyBgClass: layoutStickyBgClass } =
      usePrimarySidebarSurface();
    const resolvedStickyBgClass = stickyBgClass ?? layoutStickyBgClass;
    // Track collapsed sections
    const [mergeCollapsed, setMergeCollapsed] = useState(false);
    const [stagedCollapsed, setStagedCollapsed] = useState(false);
    const [changesCollapsed, setChangesCollapsed] = useState(false);
    // Track if panel is focused for keyboard shortcuts
    const [isPanelActive] = useState(true);

    // Which working-tree sections to render. Merge stays visible whenever
    // conflicts exist so the user can never lose access to unresolved
    // conflicts via the filter dropdown.
    const showStagedSection =
      sectionFilter === "uncommitted" || sectionFilter === "staged";
    const showUnstagedSection =
      sectionFilter === "uncommitted" || sectionFilter === "unstaged";

    // Defer the filtered file list so keystrokes in the filter input stay
    // responsive; the virtualized tree recomputes at a lower priority.
    const deferredFilteredFiles = useDeferredValue(filteredFiles);

    // File tree handling (for directory collapse state)
    const {
      stagedFiles,
      unstagedFiles,
      displayOrderFiles,
      collapsedDirs,
      handleToggleDirectory,
    } = useFileTreeHandling({
      filteredFiles: deferredFilteredFiles,
      conflictFiles,
      viewMode,
      mergeCollapsed,
      stagedCollapsed,
      changesCollapsed,
      showStagedSection,
      showUnstagedSection,
    });

    // Multi-select support
    const {
      selectedFileIds,
      handleFileClick,
      selectAll: _selectAll,
      clearSelection,
      isFileSelected,
      getSelectedFiles,
    } = useFileSelection({
      files: displayOrderFiles,
    });

    // Bulk operations
    const {
      handleBulkStage,
      handleBulkUnstage,
      handleBulkDiscard,
      handleFileSelectWithMultiSelect,
      handleStageToggleWithMultiSelect,
      handleDiscardWithMultiSelect,
    } = useBulkOperations({
      selectedFileIds,
      getSelectedFiles,
      clearSelection,
      onStageToggle,
      onDiscard,
      onFileSelect,
      handleFileClick,
      navigateWithoutSelecting,
    });

    // Commit logic
    const {
      hasStagedFiles,
      hasUnstagedFiles,
      hasUnresolvedConflicts,
      canCommit,
      commitButtonText,
      showPublishButton,
      showCommitAndPublishButton,
      commitAndPublishButtonText,
      showSyncButton,
    } = useCommitLogic({
      stagedFilesCount,
      unstagedFilesCount: unstagedFiles.length,
      commitMessage,
      isMerging,
      hasConflicts,
      conflictFilesCount: conflictFiles.length,
      hasUpstream,
      ahead,
      behind,
      onSync,
      onPublish,
    });

    // Keyboard shortcuts
    useSourceControlShortcuts({
      onCommit,
      onStageAll,
      onUnstageAll,
      onRefresh,
      onToggleStageSelected: () => {
        const selected = getSelectedFiles();
        if (selected.length === 1) {
          const file = selected[0];
          onStageToggle?.(file.id, !file.staged);
        } else if (selected.length > 1) {
          const hasUnstaged = selected.some((file) => !file.staged);
          if (hasUnstaged) {
            handleBulkStage();
          } else {
            handleBulkUnstage();
          }
        }
      },
      onOpenSelected: () => {
        const selected = getSelectedFiles();
        if (selected.length === 1) {
          onFileSelect(selected[0].id);
        }
      },
      onDiscardSelected: () => {
        const selected = getSelectedFiles();
        if (selected.length > 0) {
          handleBulkDiscard();
        }
      },
      canCommit:
        (stagedFilesCount > 0 || unstagedFiles.length > 0) &&
        commitMessage.trim().length > 0,
      hasSelection: selectedFileIds.size > 0,
      isActive: isPanelActive,
    });

    // Handle section toggle
    const handleSectionToggle = useCallback((section: string) => {
      switch (section) {
        case "merge":
          setMergeCollapsed((prev) => !prev);
          break;
        case "staged":
          setStagedCollapsed((prev) => !prev);
          break;
        case "unstaged":
          setChangesCollapsed((prev) => !prev);
          break;
      }
    }, []);

    // Handle stash push wrapper
    const handleStashPush = useCallback(() => {
      onStashPush?.();
    }, [onStashPush]);

    const sectionLabels = useMemo(
      () => ({
        mergeChanges: GIT_LABELS.mergeChanges,
        stagedChanges: GIT_LABELS.stagedChanges,
        changes: GIT_LABELS.changes,
      }),
      []
    );

    // Flatten all sections into virtualized tree
    const flattenedNodes = useMemo(
      () =>
        flattenSourceControlTree({
          conflictFiles,
          stagedFiles: showStagedSection ? stagedFiles : [],
          unstagedFiles: showUnstagedSection ? unstagedFiles : [],
          collapsedDirs,
          mergeCollapsed,
          stagedCollapsed,
          changesCollapsed,
          viewMode,
          loading:
            loading ||
            commitLoading ||
            syncLoading ||
            pullLoading ||
            pushLoading ||
            fetchLoading ||
            publishLoading,
          sectionLabels,
        }),
      [
        conflictFiles,
        stagedFiles,
        unstagedFiles,
        showStagedSection,
        showUnstagedSection,
        collapsedDirs,
        mergeCollapsed,
        stagedCollapsed,
        changesCollapsed,
        viewMode,
        loading,
        commitLoading,
        syncLoading,
        pullLoading,
        pushLoading,
        fetchLoading,
        publishLoading,
        sectionLabels,
      ]
    );

    // Render a single tree item
    const renderItem = useCallback(
      (item: FlattenedTreeNode<SourceControlNode>) => (
        <SourceControlTreeRow
          node={item.node}
          depth={item.depth}
          isSelected={
            item.node.file ? item.node.file.id === selectedFileId : false
          }
          isMultiSelected={
            item.node.file ? isFileSelected(item.node.file.id) : false
          }
          hasMultipleSelected={selectedFileIds.size > 1}
          onSectionToggle={handleSectionToggle}
          onStageAll={onStageAll}
          onUnstageAll={onUnstageAll}
          onDiscardAll={onDiscardAll}
          onOpenStagedChanges={onOpenStagedChanges}
          onStashPush={handleStashPush}
          hasChangesToStash={hasChangesToStash}
          stashOperationLoading={stashOperationLoading}
          onSelect={handleFileSelectWithMultiSelect}
          onStageToggle={handleStageToggleWithMultiSelect}
          onDiscard={handleDiscardWithMultiSelect}
          onDiscardFiles={onDiscardFiles}
          onToggleDirectory={handleToggleDirectory}
          onStageResolved={onStageResolved}
          showPathHint={false}
          overrideRepoPath={repoPath}
        />
      ),
      [
        selectedFileId,
        isFileSelected,
        selectedFileIds,
        handleSectionToggle,
        onStageAll,
        onUnstageAll,
        onDiscardAll,
        onOpenStagedChanges,
        handleStashPush,
        hasChangesToStash,
        stashOperationLoading,
        handleFileSelectWithMultiSelect,
        handleStageToggleWithMultiSelect,
        handleDiscardWithMultiSelect,
        onDiscardFiles,
        handleToggleDirectory,
        onStageResolved,
        repoPath,
      ]
    );

    const renderStickyItem = useCallback(
      (
        stickyNode: StickyScrollNode<SourceControlNode>,
        onClick: () => void
      ) => (
        <SourceControlStickyHeader
          stickyNode={stickyNode}
          onClick={onClick}
          stickyBgClass={resolvedStickyBgClass}
        />
      ),
      [resolvedStickyBgClass]
    );

    // Handle sticky header click — VS Code pattern: scroll-to-reveal only,
    // never toggle collapse (VirtualizedStickyTree handles the scroll)
    const handleStickyHeaderClick = useCallback(
      (_nodePath: string, _node: SourceControlNode) => {},
      []
    );

    const hasFiles =
      conflictFiles.length > 0 ||
      (showStagedSection && stagedFiles.length > 0) ||
      (showUnstagedSection && unstagedFiles.length > 0);

    const rootClassName = "flex min-h-0 flex-1 w-full flex-col overflow-hidden";
    const treeContentClassName = "min-h-0 flex-1 overflow-hidden";

    if (showOnlyStashes) {
      return (
        <div className={rootClassName}>
          {!error && onStashApply && onStashPop && onStashDrop && (
            <React.Suspense
              fallback={
                <Placeholder
                  variant="loading"
                  placement="sidebar"
                  fillParentHeight
                />
              }
            >
              <StashContent
                stashes={stashes}
                operationLoading={stashOperationLoading}
                initialCollapsed={false}
                onStashApply={onStashApply}
                onStashPop={onStashPop}
                onStashDrop={onStashDrop}
                onHistorySelectionChange={onHistorySelectionChange}
              />
            </React.Suspense>
          )}
        </div>
      );
    }

    return (
      <div className={rootClassName}>
        {/* Commit Section */}
        <CommitSection
          commitMessage={commitMessage}
          onCommitMessageChange={onCommitMessageChange}
          branchName={branchName}
          onCommit={onCommit}
          onCommitAndPush={onCommitAndPush}
          onCommitAndPublish={onCommitAndPublish}
          onCommitAndSync={onCommitAndSync}
          onAmend={onAmend}
          commitLoading={commitLoading}
          onGenerateCommitMessage={onGenerateCommitMessage}
          generateCommitMessageLoading={generateCommitMessageLoading}
          canCommit={canCommit}
          commitButtonText={commitButtonText}
          isMerging={isMerging}
          mergingBranch={mergingBranch}
          hasUnresolvedConflicts={hasUnresolvedConflicts}
          onContinueMerge={onContinueMerge}
          hasStagedFiles={hasStagedFiles}
          hasUnstagedFiles={hasUnstagedFiles}
          showPublishButton={showPublishButton}
          showCommitAndPublishButton={showCommitAndPublishButton}
          commitAndPublishButtonText={commitAndPublishButtonText}
          onPublish={onPublish}
          publishLoading={publishLoading}
          showSyncButton={showSyncButton}
          onSync={onSync}
          syncLoading={syncLoading}
          onPull={onPull}
          pullLoading={pullLoading}
          onPush={onPush}
          pushLoading={pushLoading}
          onFetch={onFetch}
          fetchLoading={fetchLoading}
          ahead={ahead}
          behind={behind}
        />

        {/* Filter input - conditionally rendered */}
        {showFilter && (
          <div className={`shrink-0 px-3 pb-2 ${surfaceBgClass}`}>
            <Input
              prefix={
                <HugeiconsIcon
                  icon={FilterIcon}
                  data-icon="filter-icon"
                  size={14}
                  strokeWidth={1.75}
                />
              }
              placeholder={t("placeholders.filterChanges")}
              value={searchQuery}
              onChange={onSearchChange}
              size="small"
              className="input-pane-surface"
            />
          </div>
        )}

        {/* Virtualized tree content */}
        <div
          className={treeContentClassName}
          onClick={(event) => {
            // Clear selection when clicking in empty area
            const target = event.target as HTMLElement;
            if (target === event.currentTarget && selectedFileIds.size > 0) {
              clearSelection();
            }
          }}
        >
          {/* Loading State - only show on initial load when no files exist */}
          {loading && files.length === 0 && !suppressLoadingPlaceholder && (
            <Placeholder
              variant="loading"
              placement="sidebar"
              title={t("placeholders.loadingChanges")}
              fillParentHeight
            />
          )}

          {/* Error State */}
          {error && !loading && (
            <Placeholder
              variant="error"
              placement="sidebar"
              title={error}
              fillParentHeight
            />
          )}

          {/* Virtualized Tree */}
          {!error && hasFiles && (
            <VirtualizedStickyTree
              flattenedNodes={
                flattenedNodes as FlattenedTreeNode<SourceControlNode>[]
              }
              rowHeight={TREE_ROW_HEIGHT}
              renderItem={renderItem}
              renderStickyItem={renderStickyItem}
              onStickyHeaderClick={handleStickyHeaderClick}
              emptyMessage="No changes"
              stickyBgClass={resolvedStickyBgClass}
            />
          )}

          {/* No Search Results */}
          {!error &&
            !loading &&
            files.length > 0 &&
            filteredFiles.length === 0 && (
              <Placeholder
                variant="empty"
                title={t("placeholders.noFilesFound")}
                subtitle={t("placeholders.noFilesSubtitle")}
              />
            )}
        </div>
      </div>
    );
  }
);

SourceControlContent.displayName = "SourceControlContent";

export default SourceControlContent;
