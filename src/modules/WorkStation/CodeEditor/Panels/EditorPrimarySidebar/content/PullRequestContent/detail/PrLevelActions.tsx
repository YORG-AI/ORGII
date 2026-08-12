import type { TFunction } from "i18next";
import {
  CircleDot,
  GitMerge,
  GitPullRequestClosed,
  UserRound,
  XCircle,
} from "lucide-react";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  GitHubChecksSummary,
  GitHubIssueUser,
  PullRequestMergeMethod,
} from "@src/api/tauri/github";
import Avatar from "@src/components/Avatar";
import Button from "@src/components/Button";
import Dropdown from "@src/components/Dropdown";
import { DropdownItem, DropdownPanel } from "@src/components/Dropdown/exports";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import Message from "@src/components/Message";
import {
  presentPullRequestActions,
  readRequestedReviewers,
} from "@src/shared/pr/prLevelActions";
import type { PrIdentity } from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

interface PrLevelActionsProps {
  identity: PrIdentity;
  detail: Record<string, unknown> | null;
  checks: GitHubChecksSummary | null;
  disabled: boolean;
  pending: boolean;
  reviewerCandidates: GitHubIssueUser[];
  loadingReviewerCandidates: boolean;
  reviewerCandidatesError: string | null;
  onLoadReviewerCandidates: () => Promise<void>;
  onMerge: (method: PullRequestMergeMethod) => Promise<void>;
  onSetAutoMerge: (
    enabled: boolean,
    method: PullRequestMergeMethod
  ) => Promise<void>;
  onStateChange: (state: "open" | "closed") => Promise<void>;
  onRequestedReviewersChange: (reviewers: string[]) => Promise<void>;
}

const ACTION_LABEL_KEYS: Record<string, string> = {
  Merge: "merge",
  "Squash and merge": "squash",
  "Rebase and merge": "rebase",
  "Enable auto-merge": "enableAutoMerge",
  "Merge when ready": "mergeWhenReady",
  "Disable auto-merge": "disableAutoMerge",
  "Remove from merge queue": "removeFromMergeQueue",
  Merged: "merged",
  Closed: "closed",
  Draft: "draft",
  "In merge queue": "inMergeQueue",
  "Approval required": "approvalRequired",
  "Changes requested": "changesRequested",
  "Checks failed": "checksFailed",
  "Checks pending": "checksPending",
  "Merge blocked": "mergeBlocked",
};

const ACTION_TOOLTIP_KEYS: Record<string, string> = {
  "Merge this pull request on GitHub": "merge",
  "This pull request is already merged": "alreadyMerged",
  "Reopen this pull request before merging": "reopenBeforeMerging",
  "Mark this pull request ready for review before merging": "markReady",
  "GitHub will merge this pull request through the merge queue": "mergeQueue",
  "GitHub requires review approval before merging": "approvalRequired",
  "Requested changes must be resolved before merging": "changesRequested",
  "Resolve merge conflicts before merging": "resolveConflicts",
  "Required checks must pass before merging": "checksFailed",
  "Wait for required checks or enable auto-merge": "checksPending",
  "GitHub reports unmet merge requirements": "mergeBlocked",
};

function localizedActionLabel(t: TFunction, label: string): string {
  const key = ACTION_LABEL_KEYS[label];
  return key ? t(`git.pr.actions.${key}`, label) : label;
}

function localizedActionTooltip(t: TFunction, tooltip: string): string {
  const key = ACTION_TOOLTIP_KEYS[tooltip];
  return key ? t(`git.pr.actions.tooltips.${key}`, tooltip) : tooltip;
}

export const PrLevelActions: React.FC<PrLevelActionsProps> = ({
  identity,
  detail,
  checks,
  disabled,
  pending,
  reviewerCandidates,
  loadingReviewerCandidates,
  reviewerCandidatesError,
  onLoadReviewerCandidates,
  onMerge,
  onSetAutoMerge,
  onStateChange,
  onRequestedReviewersChange,
}) => {
  const { t } = useTranslation("common");
  const [mergeMenuVisible, setMergeMenuVisible] = useState(false);
  const [reviewerMenuVisible, setReviewerMenuVisible] = useState(false);
  const presentation = presentPullRequestActions({
    detail,
    fallbackStatus: identity.status,
    checks,
  });
  const requestedReviewers = readRequestedReviewers(detail);
  const requestedReviewerLogins = requestedReviewers.map(
    (reviewer) => reviewer.login
  );
  const interactionDisabled = disabled || pending;
  const reviewerOptions = (() => {
    const unique = new Map<string, GitHubIssueUser>();
    for (const reviewer of [...requestedReviewers, ...reviewerCandidates]) {
      unique.set(reviewer.login.toLowerCase(), reviewer);
    }
    return [...unique.values()].map((reviewer) => ({
      value: reviewer.login,
      label: (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar size={18} src={reviewer.avatar_url}>
            {reviewer.login.charAt(0).toUpperCase()}
          </Avatar>
          <span className="truncate">{reviewer.login}</span>
        </span>
      ),
      triggerLabel: reviewer.login,
    }));
  })();

  const reportAction = async (
    action: () => Promise<void>,
    successMessage: string
  ): Promise<void> => {
    try {
      await action();
      Message.success(successMessage);
    } catch (error) {
      Message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const merge = async (method: PullRequestMergeMethod): Promise<void> => {
    setMergeMenuVisible(false);
    const confirmed = await confirmDestructiveAction({
      title: t("git.pr.actions.confirmMergeTitle", "Merge pull request?"),
      message: t(
        "git.pr.actions.confirmMergeMessage",
        "GitHub will merge the current pull request head into the base branch."
      ),
      okLabel: t("git.pr.actions.merge", "Merge"),
      cancelLabel: t("actions.cancel", "Cancel"),
    });
    if (!confirmed) return;
    await reportAction(
      () => onMerge(method),
      t("git.pr.actions.mergeSuccess", "Pull request merged")
    );
  };

  const toggleAutoMerge = async (): Promise<void> => {
    const action = presentation.autoMergeAction;
    if (!action) return;
    setMergeMenuVisible(false);
    const enabled = action.kind === "enable";
    await reportAction(
      () => onSetAutoMerge(enabled, presentation.defaultMethod),
      action.label === "Merge when ready"
        ? t("git.pr.actions.mergeRequested", "Merge requested")
        : action.label === "Remove from merge queue"
          ? t("git.pr.actions.removedFromQueue", "Removed from merge queue")
          : enabled
            ? t("git.pr.actions.autoMergeEnabled", "Auto-merge enabled")
            : t("git.pr.actions.autoMergeDisabled", "Auto-merge disabled")
    );
  };

  const runPrimaryMergeAction = (): void => {
    if (presentation.autoMergeAction?.kind === "disable") {
      void toggleAutoMerge();
    } else if (presentation.directMergeAvailable) {
      void merge(presentation.defaultMethod);
    } else if (presentation.autoMergeAction?.kind === "enable") {
      void toggleAutoMerge();
    }
  };

  const nextState = presentation.status === "closed" ? "open" : "closed";
  const canChangeState = presentation.status !== "merged";
  const changeState = async (): Promise<void> => {
    if (nextState === "closed") {
      const confirmed = await confirmDestructiveAction({
        title: t("git.pr.actions.confirmCloseTitle", "Close pull request?"),
        message: t(
          "git.pr.actions.confirmCloseMessage",
          "The pull request will remain available and can be reopened later."
        ),
        okLabel: "Close",
        cancelLabel: t("actions.cancel", "Cancel"),
      });
      if (!confirmed) return;
    }
    await reportAction(
      () => onStateChange(nextState),
      nextState === "closed"
        ? t("git.pr.actions.closeSuccess", "Pull request closed")
        : t("git.pr.actions.reopenSuccess", "Pull request reopened")
    );
  };
  const mergePanel = (
    <DropdownPanel className={DROPDOWN_WIDTHS.wideMenuClass}>
      <div className={DROPDOWN_CLASSES.itemsColumnPadded}>
        {presentation.autoMergeAction ? (
          <>
            <DropdownItem
              icon={<GitMerge size={DROPDOWN_ITEM.iconSize} aria-hidden />}
              disabled={interactionDisabled}
              onClick={() => void toggleAutoMerge()}
              dataTestId="pr-auto-merge-action"
            >
              {localizedActionLabel(t, presentation.autoMergeAction.label)}
            </DropdownItem>
            <div className={DROPDOWN_CLASSES.menuSeparatorInset} />
          </>
        ) : null}
        {presentation.methods.map(({ method, label }) => (
          <DropdownItem
            key={method}
            icon={<GitMerge size={DROPDOWN_ITEM.iconSize} aria-hidden />}
            disabled={interactionDisabled || !presentation.directMergeAvailable}
            onClick={() => void merge(method)}
            dataTestId={`pr-merge-${method}`}
          >
            {localizedActionLabel(t, label)}
          </DropdownItem>
        ))}
      </div>
    </DropdownPanel>
  );

  const primaryDisabled =
    interactionDisabled ||
    (!presentation.directMergeAvailable && !presentation.autoMergeAction);

  return (
    <section
      className="flex min-h-9 flex-wrap items-center gap-2 px-1"
      aria-label={t("git.pr.actions.label", "Pull request actions")}
      data-testid="pr-level-actions"
    >
      <Button
        htmlType="button"
        variant={
          presentation.hasConflicts
            ? "danger"
            : presentation.status === "merged"
              ? "merged"
              : "success"
        }
        appearance={presentation.hasConflicts ? "outline" : undefined}
        size="small"
        shape="round"
        icon={
          presentation.hasConflicts ? (
            <XCircle size={14} aria-hidden />
          ) : (
            <GitMerge size={14} aria-hidden />
          )
        }
        loading={pending}
        disabled={primaryDisabled}
        className={primaryDisabled ? "!opacity-100" : undefined}
        title={localizedActionTooltip(t, presentation.tooltip)}
        onClick={runPrimaryMergeAction}
        dropdownMenu={
          presentation.hasConflicts ? undefined : (
            <Dropdown
              droplist={mergePanel}
              trigger="click"
              popupVisible={mergeMenuVisible}
              onVisibleChange={setMergeMenuVisible}
              getPopupContainer={() => document.body}
              avoidViewportOverflow
            >
              <div />
            </Dropdown>
          )
        }
        onDropdownClick={
          presentation.hasConflicts
            ? undefined
            : (event) => {
                event.stopPropagation();
                setMergeMenuVisible((visible) => !visible);
              }
        }
        dropdownVisible={mergeMenuVisible}
        splitWidthMode="hug"
        splitDropdownWidth={28}
        aria-expanded={presentation.hasConflicts ? undefined : mergeMenuVisible}
        data-testid="pr-merge-action"
      >
        {localizedActionLabel(
          t,
          presentation.autoMergeAction?.kind === "disable" ||
            (!presentation.directMergeAvailable &&
              presentation.autoMergeAction?.kind === "enable")
            ? presentation.autoMergeAction.label
            : presentation.label
        )}
      </Button>

      <Dropdown
        options={reviewerOptions}
        value={requestedReviewerLogins}
        mode="multiple"
        showSearch
        searchPlaceholder={t(
          "git.pr.actions.searchReviewers",
          "Search reviewers"
        )}
        loading={loadingReviewerCandidates}
        emptyContent={
          reviewerCandidatesError
            ? t(
                "git.pr.actions.reviewersLoadFailed",
                "Could not load reviewers"
              )
            : t("git.pr.actions.noReviewers", "No reviewers available")
        }
        disabled={interactionDisabled || presentation.status !== "open"}
        popupVisible={reviewerMenuVisible}
        onVisibleChange={(visible) => {
          setReviewerMenuVisible(visible);
          if (visible) void onLoadReviewerCandidates();
        }}
        getPopupContainer={() => document.body}
        avoidViewportOverflow
        className={`${DROPDOWN_CLASSES.panelAnimated} ${DROPDOWN_WIDTHS.fileTreeClass}`}
        onSelect={(value) => {
          const next = Array.isArray(value)
            ? value.map(String)
            : [String(value)];
          setReviewerMenuVisible(false);
          void reportAction(
            () => onRequestedReviewersChange(next),
            t("git.pr.actions.reviewersUpdated", "Reviewers updated")
          );
        }}
      >
        <Button
          htmlType="button"
          variant="secondary"
          appearance="outline"
          size="small"
          shape="round"
          icon={<UserRound size={14} aria-hidden />}
          disabled={interactionDisabled || presentation.status !== "open"}
          data-testid="pr-reviewer-action"
        >
          {requestedReviewerLogins.length > 0
            ? t("git.pr.actions.reviewersCount", {
                count: requestedReviewerLogins.length,
                defaultValue: "{{count}} reviewer",
                defaultValue_other: "{{count}} reviewers",
              })
            : t("git.pr.actions.reviewers", "Reviewers")}
        </Button>
      </Dropdown>

      {canChangeState ? (
        <Button
          htmlType="button"
          variant="secondary"
          appearance="outline"
          size="small"
          shape="round"
          icon={
            nextState === "closed" ? (
              <GitPullRequestClosed size={14} aria-hidden />
            ) : (
              <CircleDot size={14} aria-hidden />
            )
          }
          disabled={interactionDisabled}
          onClick={() => void changeState()}
          data-testid="pr-state-action"
        >
          {nextState === "closed"
            ? "Close"
            : t("git.pr.actions.reopen", "Reopen pull request")}
        </Button>
      ) : null}
    </section>
  );
};

PrLevelActions.displayName = "PrLevelActions";
