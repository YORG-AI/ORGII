/**
 * CommitSection Component
 *
 * Handles the commit message input and action buttons:
 * - Publish Branch button (when no upstream)
 * - Sync Changes button (when have commits to sync)
 * - Commit button with dropdown for advanced actions
 */
import React, { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Dropdown from "@src/components/Dropdown";
import Menu from "@src/components/Menu";
import SplitButton from "@src/components/SplitButton";
import Textarea from "@src/components/Textarea";
import {
  ArrowDown02Icon,
  ArrowUp02Icon,
  CloudUploadIcon,
  HugeiconsIcon,
  Refresh04Icon,
  Tick01Icon,
} from "@src/icons";

import { SHORTCUTS } from "../../../hooks/useSourceControlShortcuts";
import { GIT_LABELS, formatCommitCount } from "../config";

export interface CommitSectionProps {
  // Commit message
  commitMessage: string;
  onCommitMessageChange: (value: string) => void;
  branchName?: string;

  // Commit actions
  onCommit: () => void;
  onCommitAndPush?: () => void;
  onCommitAndPublish?: () => void;
  onCommitAndSync?: () => void;
  onAmend?: () => void;
  commitLoading: boolean;
  canCommit: boolean;
  commitButtonText: string;

  // AI commit message generation
  onGenerateCommitMessage?: () => void;
  generateCommitMessageLoading?: boolean;

  // Merge state
  isMerging: boolean;
  mergingBranch?: string;
  hasUnresolvedConflicts: boolean;
  onContinueMerge?: () => void;

  // Staged/unstaged info for tooltips
  hasStagedFiles: boolean;
  hasUnstagedFiles: boolean;

  // Publish state
  showPublishButton: boolean;
  showCommitAndPublishButton: boolean;
  commitAndPublishButtonText: string;
  onPublish?: () => Promise<void>;
  publishLoading: boolean;

  // Sync state
  showSyncButton: boolean;
  onSync?: () => void;
  syncLoading: boolean;
  onPull?: () => void;
  pullLoading?: boolean;
  onPush?: () => void;
  pushLoading?: boolean;
  onFetch?: () => void;
  fetchLoading?: boolean;
  ahead: number;
  behind: number;
}

export const CommitSection: React.FC<CommitSectionProps> = memo(
  ({
    commitMessage,
    onCommitMessageChange,
    branchName,
    onCommit,
    onCommitAndPush,
    onCommitAndPublish,
    onCommitAndSync,
    onAmend,
    commitLoading,
    canCommit,
    commitButtonText,
    onGenerateCommitMessage,
    generateCommitMessageLoading = false,
    isMerging,
    mergingBranch,
    hasUnresolvedConflicts,
    onContinueMerge,
    hasStagedFiles,
    hasUnstagedFiles,
    showPublishButton,
    showCommitAndPublishButton,
    commitAndPublishButtonText,
    onPublish,
    publishLoading,
    showSyncButton,
    onSync,
    syncLoading,
    onPull,
    pullLoading = false,
    onPush,
    pushLoading = false,
    onFetch,
    fetchLoading = false,
    ahead,
    behind,
  }) => {
    const { t } = useTranslation();

    // State for dropdown visibility
    const [dropdownVisible, setDropdownVisible] = useState(false);
    const [syncDropdownVisible, setSyncDropdownVisible] = useState(false);

    // Check if any advanced actions are available
    const hasAdvancedActions =
      !isMerging &&
      (onCommitAndPush || onCommitAndPublish || onCommitAndSync || onAmend);

    // Check if sync dropdown has individual actions available
    const hasSyncActions = onPull || onPush || onFetch;

    // Whether any sync-area operation is loading
    const anySyncLoading =
      syncLoading || pullLoading || pushLoading || fetchLoading;

    // Sync only makes sense when both ahead AND behind
    const hasBothDirections = ahead > 0 && behind > 0;

    // Primary action: push-only, pull-only, or full sync
    const primarySyncAction = hasBothDirections
      ? onSync
      : ahead > 0
        ? (onPush ?? onSync)
        : (onPull ?? onSync);

    // Handle menu item click
    const handleMenuClick = useCallback((action: () => void) => {
      setDropdownVisible(false);
      action();
    }, []);

    // Handle sync menu item click
    const handleSyncMenuClick = useCallback((action: () => void) => {
      setSyncDropdownVisible(false);
      action();
    }, []);

    // Build sync button label based on ahead/behind state
    const getSyncLabel = () => {
      if (pullLoading) {
        return <span className="font-medium">{GIT_LABELS.pulling}</span>;
      }
      if (pushLoading) {
        return <span className="font-medium">{GIT_LABELS.pushing}</span>;
      }
      if (fetchLoading) {
        return <span className="font-medium">{GIT_LABELS.fetching}</span>;
      }
      if (syncLoading) {
        return <span className="font-medium">{GIT_LABELS.syncing}</span>;
      }

      const parts: React.ReactNode[] = [];

      if (hasBothDirections) {
        parts.push(
          <HugeiconsIcon
            icon={Refresh04Icon}
            data-icon="refresh-cw"
            size={14}
            className="mr-1.5"
            key="icon"
          />
        );
        parts.push(<span key="text">{GIT_LABELS.syncChanges}</span>);
        parts.push(
          <span key="behind" className="ml-1.5 flex items-center">
            {behind}
            <HugeiconsIcon
              icon={ArrowDown02Icon}
              data-icon="arrow-down"
              size={12}
              className="ml-0.5"
            />
          </span>
        );
        parts.push(
          <span key="ahead" className="ml-1.5 flex items-center">
            {ahead}
            <HugeiconsIcon
              icon={ArrowUp02Icon}
              data-icon="arrow-up"
              size={12}
              className="ml-0.5"
            />
          </span>
        );
      } else if (ahead > 0) {
        parts.push(
          <HugeiconsIcon
            icon={ArrowUp02Icon}
            data-icon="arrow-up"
            size={14}
            className="mr-1.5"
            key="icon"
          />
        );
        parts.push(<span key="text">{formatCommitCount("Push", ahead)}</span>);
      } else if (behind > 0) {
        parts.push(
          <HugeiconsIcon
            icon={ArrowDown02Icon}
            data-icon="arrow-down"
            size={14}
            className="mr-1.5"
            key="icon"
          />
        );
        parts.push(<span key="text">{formatCommitCount("Pull", behind)}</span>);
      }

      return <span className="flex items-center justify-center">{parts}</span>;
    };

    // TODO: Re-enable when a reliable LLM provider is wired up
    const _onGenerateCommitMessage = onGenerateCommitMessage;
    const _generateCommitMessageLoading = generateCommitMessageLoading;
    const sparkleButton = null;

    const commitMessagePlaceholder = t("placeholders.commitMessage");
    const wrapperClass = "flex-shrink-0 px-3 pb-2 pt-1";
    const innerGap = "relative mb-2";
    const textareaClassName = "textarea-pane-surface text-[13px]";

    // Publish Branch button
    if (showPublishButton) {
      return (
        <div className={wrapperClass}>
          <div className={innerGap}>
            <Textarea
              placeholder={commitMessagePlaceholder}
              value={commitMessage}
              onChange={onCommitMessageChange}
              rows={2}
              className={textareaClassName}
            />
            {sparkleButton}
          </div>
          <Button
            variant="primary"
            size="small"
            className="w-full"
            onClick={onPublish}
            disabled={publishLoading}
            loading={publishLoading}
            title={`Publish branch "${branchName}" to origin`}
            data-action="git.publish"
            icon={
              publishLoading ? undefined : (
                <HugeiconsIcon
                  icon={CloudUploadIcon}
                  data-icon="cloud-upload"
                  size={14}
                  className="mr-1.5"
                />
              )
            }
          >
            {publishLoading ? (
              <span className="font-medium">
                {t("workstation.publishingBranch")}
              </span>
            ) : (
              <span className="flex min-w-0 max-w-full items-center justify-center">
                <span className="flex-shrink-0">{GIT_LABELS.publish}</span>
                {branchName && (
                  <span className="ml-1 min-w-0 truncate font-bold">
                    {branchName}
                  </span>
                )}
                <span className="ml-1 flex-shrink-0">
                  {t("workstation.toOrigin")}
                </span>
              </span>
            )}
          </Button>
        </div>
      );
    }

    if (showCommitAndPublishButton) {
      return (
        <div className={wrapperClass}>
          <div className={innerGap}>
            <Textarea
              placeholder={commitMessagePlaceholder}
              value={commitMessage}
              onChange={onCommitMessageChange}
              rows={2}
              className={textareaClassName}
            />
            {sparkleButton}
          </div>
          <Button
            variant="primary"
            size="small"
            className="w-full"
            onClick={onCommitAndPublish}
            disabled={!canCommit || !onCommitAndPublish}
            loading={commitLoading || publishLoading}
            title={
              !hasStagedFiles && hasUnstagedFiles
                ? `No staged changes. Will stage all changes, commit, and publish the branch (Smart Commit)`
                : "Commit changes and publish the branch"
            }
            data-action="git.commit.publish"
            icon={
              <HugeiconsIcon
                icon={CloudUploadIcon}
                data-icon="cloud-upload"
                size={14}
              />
            }
          >
            {commitAndPublishButtonText}
          </Button>
        </div>
      );
    }

    // Sync Changes button (with dropdown for Pull, Push, Fetch)
    if (showSyncButton) {
      return (
        <div className={wrapperClass}>
          <div className={innerGap}>
            <Textarea
              placeholder={commitMessagePlaceholder}
              value={commitMessage}
              onChange={onCommitMessageChange}
              rows={2}
              className={textareaClassName}
            />
            {sparkleButton}
          </div>
          {hasSyncActions ? (
            <SplitButton
              variant="primary"
              size="small"
              className="w-full"
              onClick={primarySyncAction}
              disabled={anySyncLoading}
              loading={anySyncLoading}
              title={
                hasBothDirections
                  ? GIT_LABELS.syncChanges
                  : ahead > 0
                    ? formatCommitCount("Push", ahead)
                    : formatCommitCount("Pull", behind)
              }
              data-action="git.sync"
              menu={
                <Dropdown
                  droplist={
                    <Menu>
                      {hasBothDirections && onSync && (
                        <Menu.Item
                          key="sync"
                          onClick={() => handleSyncMenuClick(onSync)}
                        >
                          {GIT_LABELS.syncChanges}
                        </Menu.Item>
                      )}
                      {onPull && (
                        <Menu.Item
                          key="pull"
                          onClick={() => handleSyncMenuClick(onPull)}
                        >
                          {GIT_LABELS.pull}
                          {behind > 0 && (
                            <span className="ml-1.5 text-text-3">
                              {behind}
                              <HugeiconsIcon
                                icon={ArrowDown02Icon}
                                data-icon="arrow-down"
                                size={10}
                                className="ml-0.5 inline"
                              />
                            </span>
                          )}
                        </Menu.Item>
                      )}
                      {onPush && (
                        <Menu.Item
                          key="push"
                          onClick={() => handleSyncMenuClick(onPush)}
                        >
                          {GIT_LABELS.push}
                          {ahead > 0 && (
                            <span className="ml-1.5 text-text-3">
                              {ahead}
                              <HugeiconsIcon
                                icon={ArrowUp02Icon}
                                data-icon="arrow-up"
                                size={10}
                                className="ml-0.5 inline"
                              />
                            </span>
                          )}
                        </Menu.Item>
                      )}
                      {onFetch && (
                        <Menu.Item
                          key="fetch"
                          onClick={() => handleSyncMenuClick(onFetch)}
                        >
                          {GIT_LABELS.fetch}
                        </Menu.Item>
                      )}
                    </Menu>
                  }
                  trigger="click"
                  position="bottom-end"
                  popupVisible={syncDropdownVisible}
                  onVisibleChange={setSyncDropdownVisible}
                >
                  <div />
                </Dropdown>
              }
              onMenuButtonClick={(event) => {
                event.stopPropagation();
                setSyncDropdownVisible(!syncDropdownVisible);
              }}
              menuOpen={syncDropdownVisible}
              menuButtonLabel={GIT_LABELS.syncChanges}
            >
              {getSyncLabel()}
            </SplitButton>
          ) : (
            <Button
              variant="primary"
              size="small"
              className="w-full"
              onClick={primarySyncAction}
              disabled={anySyncLoading}
              loading={anySyncLoading}
              title={
                hasBothDirections
                  ? GIT_LABELS.syncChanges
                  : ahead > 0
                    ? formatCommitCount("Push", ahead)
                    : formatCommitCount("Pull", behind)
              }
              data-action="git.sync"
            >
              {getSyncLabel()}
            </Button>
          )}
        </div>
      );
    }

    // Commit section (default)
    return (
      <div className={wrapperClass}>
        <div className={innerGap}>
          <Textarea
            placeholder={
              isMerging && mergingBranch
                ? `Merge branch '${mergingBranch}' into ${branchName || "current"}`
                : commitMessagePlaceholder
            }
            value={commitMessage}
            onChange={onCommitMessageChange}
            rows={2}
            className={textareaClassName}
          />
          {sparkleButton}
        </div>

        {/* Merge Continue Button */}
        {isMerging ? (
          <Button
            variant="primary"
            size="small"
            className="w-full"
            onClick={onContinueMerge || onCommit}
            disabled={!canCommit}
            loading={commitLoading}
            title={
              hasUnresolvedConflicts
                ? "Resolve all conflicts before completing the merge"
                : "Complete merge"
            }
            data-action="git.commit"
            icon={
              <HugeiconsIcon icon={Tick01Icon} data-icon="check" size={14} />
            }
          >
            {commitButtonText}
          </Button>
        ) : hasAdvancedActions ? (
          /* Commit button with dropdown */
          <SplitButton
            variant="primary"
            size="small"
            className="w-full"
            onClick={onCommit}
            disabled={!canCommit}
            loading={commitLoading}
            title={
              !hasStagedFiles && hasUnstagedFiles
                ? `No staged changes. Will stage all changes and commit (Smart Commit)\n\nShortcut: ${SHORTCUTS.commit}`
                : `Commit changes\n\nShortcut: ${SHORTCUTS.commit}`
            }
            data-action="git.commit"
            menu={
              <Dropdown
                droplist={
                  <Menu>
                    <Menu.Item
                      key="commit"
                      onClick={() => handleMenuClick(onCommit)}
                    >
                      {GIT_LABELS.commit}
                    </Menu.Item>
                    {onAmend && (
                      <Menu.Item
                        key="amend"
                        onClick={() => handleMenuClick(onAmend)}
                      >
                        {GIT_LABELS.commitAmend}
                      </Menu.Item>
                    )}
                    {onCommitAndPush && (
                      <Menu.Item
                        key="commit-push"
                        onClick={() => handleMenuClick(onCommitAndPush)}
                      >
                        {GIT_LABELS.commitAndPush}
                      </Menu.Item>
                    )}
                    {onCommitAndPublish && (
                      <Menu.Item
                        key="commit-publish"
                        onClick={() => handleMenuClick(onCommitAndPublish)}
                      >
                        {GIT_LABELS.commitAndPublish}
                      </Menu.Item>
                    )}
                    {onCommitAndSync && (
                      <Menu.Item
                        key="commit-sync"
                        onClick={() => handleMenuClick(onCommitAndSync)}
                      >
                        {GIT_LABELS.commitAndSync}
                      </Menu.Item>
                    )}
                  </Menu>
                }
                trigger="click"
                position="bottom-end"
                popupVisible={dropdownVisible}
                onVisibleChange={setDropdownVisible}
              >
                <div />
              </Dropdown>
            }
            onMenuButtonClick={(event) => {
              event.stopPropagation();
              setDropdownVisible(!dropdownVisible);
            }}
            menuOpen={dropdownVisible}
            menuButtonLabel={commitButtonText}
            contentAlignment="whole"
          >
            {commitButtonText}
          </SplitButton>
        ) : (
          /* Simple Commit Button */
          <Button
            variant="primary"
            size="small"
            className="w-full"
            onClick={onCommit}
            disabled={!canCommit}
            loading={commitLoading}
            title={
              !hasStagedFiles && hasUnstagedFiles
                ? `No staged changes. Will stage all changes and commit (Smart Commit)\n\nShortcut: ${SHORTCUTS.commit}`
                : `Commit changes\n\nShortcut: ${SHORTCUTS.commit}`
            }
            data-action="git.commit"
          >
            {commitButtonText}
          </Button>
        )}
      </div>
    );
  }
);

CommitSection.displayName = "CommitSection";

export default CommitSection;
