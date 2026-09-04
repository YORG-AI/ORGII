/**
 * StashContent Component
 *
 * Displays git stashes in a collapsible section with:
 * - List of stashes with index and message
 * - Actions: Apply, Pop, Drop per stash
 * - Pop All button in header
 *
 * Only renders when there are stashes.
 * Follows the same layout pattern as SourceControlChanges.
 */
import React, { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { StashEntry } from "@src/api/http/git/types";
import {
  TREE_ROW_INSET_CLASS,
  TREE_ROW_ROUNDED_CLASS,
  TreeRowBase,
  type TreeRowNode,
} from "@src/components/TreeRow";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import { useWorkStationTabs } from "@src/hooks/tabHost/useWorkStationTabs";
import {
  ArchiveArrowUpIcon,
  ArrowDown01Icon,
  ArrowDownToLineIcon,
  ArrowRight01Icon,
  Delete02Icon,
  HugeiconsIcon,
  Loading03Icon,
  PackageIcon,
} from "@src/icons";
import {
  COUNT_BADGE,
  HEADER_BUTTON,
  PRIMARY_SIDEBAR_HOVER,
  getCountBadgeSizeClass,
} from "@src/modules/WorkStation/shared/tokens";
import {
  type SourceControlHistorySelection,
  createStashDetailTab,
} from "@src/store/workstation/tabs";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

// ============================================
// Types
// ============================================

interface StashContentProps {
  /** List of stashes */
  stashes: StashEntry[];
  /** Whether any stash operation is in progress */
  operationLoading: boolean;
  /** Whether the stash list starts collapsed. */
  initialCollapsed?: boolean;
  /** Callback to apply a stash (keeps stash) */
  onStashApply: (index: number) => Promise<boolean>;
  /** Callback to pop a stash (applies and removes) */
  onStashPop: (index: number) => Promise<boolean>;
  /** Callback to drop a stash (removes without applying) */
  onStashDrop: (index: number) => Promise<boolean>;
  /** Receives the selected stash when the host wants inline detail rendering. */
  onHistorySelectionChange?: (selection: SourceControlHistorySelection) => void;
}

// ============================================
// StashItem Component
// ============================================

interface StashItemProps {
  stash: StashEntry;
  operationLoading: boolean;
  isSelected: boolean;
  onApply: (index: number) => Promise<boolean>;
  onPop: (index: number) => Promise<boolean>;
  onDrop: (index: number) => Promise<boolean>;
  onOpenDetail: (stash: StashEntry) => void;
}

function getStashIdentity(stash: StashEntry): string {
  const normalizedCommitSha = stash.commit_sha?.trim();
  return normalizedCommitSha || `stash@{${stash.index}}`;
}

function getStashDisplayMessage(stash: StashEntry): string {
  const displayMessage = stash.message || `stash@{${stash.index}}`;
  const messageMatch = displayMessage.match(/: (.+)$/);
  return messageMatch ? messageMatch[1] : displayMessage;
}

function createStashHistorySelection(
  stash: StashEntry
): Extract<SourceControlHistorySelection, { type: "stash" }> {
  const stashRef = `stash@{${stash.index}}`;
  const normalizedCommitSha = stash.commit_sha?.trim();
  const stashIdentity = normalizedCommitSha || stashRef;
  const shortSha =
    normalizedCommitSha && normalizedCommitSha.length >= 8
      ? normalizedCommitSha.slice(0, 8)
      : stashRef;

  return {
    type: "stash",
    stashIndex: stash.index,
    stashRef,
    stashIdentity,
    stashCommitSha: normalizedCommitSha ?? null,
    commitSha: stashIdentity,
    shortSha,
    commitMessage: getStashDisplayMessage(stash) || stashRef,
  };
}

const StashItem: React.FC<StashItemProps> = memo(
  ({
    stash,
    operationLoading,
    isSelected,
    onApply,
    onPop,
    onDrop,
    onOpenDetail,
  }) => {
    const { t } = useTranslation();
    const [actionLoading, setActionLoading] = useState<
      "apply" | "pop" | "drop" | null
    >(null);

    const handleApply = useCallback(
      async (event: React.MouseEvent) => {
        event.stopPropagation();
        setActionLoading("apply");
        await onApply(stash.index);
        setActionLoading(null);
      },
      [stash.index, onApply]
    );

    const handlePop = useCallback(
      async (event: React.MouseEvent) => {
        event.stopPropagation();
        setActionLoading("pop");
        await onPop(stash.index);
        setActionLoading(null);
      },
      [stash.index, onPop]
    );

    const handleDrop = useCallback(
      async (event: React.MouseEvent) => {
        event.stopPropagation();
        const shortMessage = getStashDisplayMessage(stash);
        const stashRef =
          shortMessage && !shortMessage.startsWith("stash@")
            ? `stash@{${stash.index}} (${shortMessage})`
            : `stash@{${stash.index}}`;

        const confirmed = await confirmDestructiveAction({
          title: t("confirmation.dropStashTitle"),
          message: t("confirmation.dropStashMessage", { stashRef }),
          okLabel: t("actions.delete"),
          cancelLabel: t("actions.cancel"),
        });
        if (!confirmed) return;

        setActionLoading("drop");
        await onDrop(stash.index);
        setActionLoading(null);
      },
      [stash, onDrop, t]
    );

    const handleOpenDetail = useCallback(() => {
      onOpenDetail(stash);
    }, [onOpenDetail, stash]);

    const isLoading = operationLoading || actionLoading !== null;

    const shortMessage = getStashDisplayMessage(stash);

    // Build TreeRowNode for TreeRowBase
    const treeNode: TreeRowNode = useMemo(
      () => ({
        id: `stash-${stash.index}`,
        name: shortMessage,
        path: `stash@{${stash.index}}`,
        type: "file",
        icon: (
          <HugeiconsIcon
            icon={PackageIcon}
            data-icon="package"
            size={14}
            className="text-text-3"
          />
        ),
      }),
      [stash.index, shortMessage]
    );

    return (
      <TreeRowBase
        node={treeNode}
        depth={0}
        isSelected={isSelected}
        onClick={handleOpenDetail}
      >
        {/* Index badge */}
        <span className="shrink-0 text-[11px] text-text-3">{stash.index}</span>

        {/* Branch name if available */}
        {stash.branch && (
          <span className="shrink-0 text-[11px] text-text-4">
            ({stash.branch})
          </span>
        )}

        {/* Action buttons - show on hover, no space when hidden */}
        <div className="hidden items-center gap-0.5 group-hover/item:flex">
          {/* Apply (keep stash) */}
          <button
            className={`${HEADER_BUTTON.actionTreeRow} disabled:opacity-50`}
            onClick={handleApply}
            disabled={isLoading}
            title={t("tooltips.applyStash")}
          >
            {actionLoading === "apply" ? (
              <HugeiconsIcon
                icon={Loading03Icon}
                data-icon="loader-2"
                size={SPINNER_TOKENS.small}
                className="animate-spin text-text-3"
              />
            ) : (
              <HugeiconsIcon
                icon={ArrowDownToLineIcon}
                data-icon="arrow-down-to-line"
                size={12}
                strokeWidth={1.75}
                className="text-text-2"
              />
            )}
          </button>

          {/* Pop (apply and remove) */}
          <button
            className={`${HEADER_BUTTON.actionTreeRow} disabled:opacity-50`}
            onClick={handlePop}
            disabled={isLoading}
            title={t("tooltips.popStash")}
          >
            {actionLoading === "pop" ? (
              <HugeiconsIcon
                icon={Loading03Icon}
                data-icon="loader-2"
                size={SPINNER_TOKENS.small}
                className="animate-spin text-text-3"
              />
            ) : (
              <HugeiconsIcon
                icon={ArchiveArrowUpIcon}
                data-icon="archive-restore"
                size={12}
                strokeWidth={1.75}
                className="text-success-6"
              />
            )}
          </button>

          {/* Drop (delete) */}
          <button
            className={`${HEADER_BUTTON.danger} disabled:opacity-50`}
            onClick={handleDrop}
            disabled={isLoading}
            title={t("tooltips.dropStash")}
          >
            {actionLoading === "drop" ? (
              <HugeiconsIcon
                icon={Loading03Icon}
                data-icon="loader-2"
                size={SPINNER_TOKENS.small}
                className="animate-spin text-text-3"
              />
            ) : (
              <HugeiconsIcon
                icon={Delete02Icon}
                data-icon="trash-2"
                size={12}
                strokeWidth={1.75}
                className="text-danger-6"
              />
            )}
          </button>
        </div>
      </TreeRowBase>
    );
  }
);

StashItem.displayName = "StashItem";

// ============================================
// Main Component
// ============================================

export const StashContent: React.FC<StashContentProps> = memo(
  ({
    stashes,
    operationLoading,
    initialCollapsed = true,
    onStashApply,
    onStashPop,
    onStashDrop,
    onHistorySelectionChange,
  }) => {
    const { t } = useTranslation();
    const { openTab, activeTab } = useWorkStationTabs();
    const [collapsed, setCollapsed] = useState(initialCollapsed);
    const [isPoppingAll, setIsPoppingAll] = useState(false);

    const stashCount = stashes.length;
    const hasStashes = stashCount > 0;
    const sourceControlHistorySelection =
      activeTab?.type === "source-control" &&
      activeTab.data.historySelection &&
      typeof activeTab.data.historySelection === "object"
        ? (activeTab.data.historySelection as SourceControlHistorySelection)
        : null;
    const activeStashIdentity =
      sourceControlHistorySelection?.type === "stash"
        ? sourceControlHistorySelection.stashIdentity
        : activeTab?.type === "git-stash-detail"
          ? typeof activeTab.data.stashIdentity === "string"
            ? activeTab.data.stashIdentity
            : typeof activeTab.data.stashCommitSha === "string"
              ? activeTab.data.stashCommitSha
              : typeof activeTab.data.stashRef === "string"
                ? activeTab.data.stashRef
                : null
          : null;

    const handleOpenStashDetail = useCallback(
      (stash: StashEntry) => {
        const selection = createStashHistorySelection(stash);
        if (onHistorySelectionChange) {
          onHistorySelectionChange(selection);
          return;
        }
        const tab = createStashDetailTab(
          stash.index,
          selection.commitMessage,
          stash.commit_sha
        );
        openTab(tab);
      },
      [onHistorySelectionChange, openTab]
    );

    // Handle pop all stashes (apply all from newest to oldest)
    const handlePopAll = useCallback(async () => {
      if (!hasStashes) return;

      // Confirm before popping all
      const confirmed = await confirmDestructiveAction({
        title: t("confirmation.popAllStashesTitle"),
        message: t("confirmation.popAllStashesMessage", { count: stashCount }),
        okLabel: t("actions.confirm"),
        cancelLabel: t("actions.cancel"),
      });
      if (!confirmed) return;

      setIsPoppingAll(true);
      // Pop stashes from index 0 repeatedly (as each pop removes index 0)
      for (let index = 0; index < stashCount; index++) {
        const success = await onStashPop(0);
        if (!success) break;
      }
      setIsPoppingAll(false);
    }, [hasStashes, stashCount, onStashPop, t]);

    // Don't render section if no stashes
    if (!hasStashes) {
      return null;
    }

    return (
      <div className="mb-1">
        {/* Section header */}
        <div
          className={`group/header ${TREE_ROW_INSET_CLASS} flex h-[28px] items-center gap-1.5 px-2 ${TREE_ROW_ROUNDED_CLASS} ${PRIMARY_SIDEBAR_HOVER.row}`}
        >
          <button
            className="flex items-center gap-1.5"
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? (
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                data-icon="chevron-right"
                size={14}
                className="text-text-3"
              />
            ) : (
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                data-icon="chevron-down"
                size={14}
                className="text-text-3"
              />
            )}
            <span className="text-[11px] font-medium text-text-2 uppercase">
              Stashes
            </span>
          </button>
          <div className="flex-1" />

          {/* Action buttons - show on hover */}
          <button
            className={`${HEADER_BUTTON.actionTreeRow} hidden shrink-0 group-hover/header:flex disabled:opacity-50`}
            onClick={handlePopAll}
            disabled={operationLoading || isPoppingAll}
            title={t("tooltips.popAllStashes")}
          >
            {isPoppingAll ? (
              <HugeiconsIcon
                icon={Loading03Icon}
                data-icon="loader-2"
                size={SPINNER_TOKENS.default}
                className="animate-spin text-text-3"
              />
            ) : (
              <HugeiconsIcon
                icon={ArchiveArrowUpIcon}
                data-icon="archive-restore"
                size={14}
                strokeWidth={1.75}
                className="text-text-2"
              />
            )}
          </button>

          {/* Count badge */}
          <span
            className={`${COUNT_BADGE.base} ${getCountBadgeSizeClass(stashCount)} ${COUNT_BADGE.primary}`}
          >
            {stashCount}
          </span>
        </div>

        {/* Content */}
        {!collapsed && (
          <div>
            {/* Stash list */}
            <div className="flex flex-col">
              {stashes.map((stash) => (
                <StashItem
                  key={getStashIdentity(stash)}
                  stash={stash}
                  operationLoading={operationLoading}
                  isSelected={activeStashIdentity === getStashIdentity(stash)}
                  onApply={onStashApply}
                  onPop={onStashPop}
                  onDrop={onStashDrop}
                  onOpenDetail={handleOpenStashDetail}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }
);

StashContent.displayName = "StashContent";

export default StashContent;
