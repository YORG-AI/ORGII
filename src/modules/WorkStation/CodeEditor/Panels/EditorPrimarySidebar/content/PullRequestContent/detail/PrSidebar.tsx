/**
 * PrSidebar
 *
 * GitHub-style operations rail for the PR detail panel: editable Reviewers,
 * Assignees, and Labels pickers, plus the pull-request level operations
 * (merge / auto-merge / draft / close) stacked
 * full-width like GitHub's right sidebar. Rendered on the Workstation trail
 * surface with the shared trail header + section formatting so it matches the
 * Work Item properties rail. The host mounts it beside the detail tabs, or
 * stacks it under the flow title when the pane is too narrow for two columns.
 */
import { Check, MessageCircle, Settings, XCircle } from "lucide-react";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  GitHubChecksSummary,
  GitHubIssueLabel,
  GitHubIssueUser,
  GitHubPrReview,
  PullRequestMergeMethod,
} from "@src/api/tauri/github";
import Avatar from "@src/components/Avatar";
import Dropdown from "@src/components/Dropdown";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { WORKSTATION_TRAIL_CONTENT } from "@src/config/workstation/tokens";
import {
  WorkstationTrailBody,
  WorkstationTrailEmptyText,
  WorkstationTrailIconButton,
  WorkstationTrailSection,
  WorkstationTrailSurface,
} from "@src/modules/shared/layouts/blocks";
import {
  presentPullRequestActions,
  readRequestedReviewers,
} from "@src/shared/pr/prLevelActions";
import type { PrIdentity } from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";

import { PrLevelActions, reportPrAction } from "./PrLevelActions";

// ── Detail payload readers ───────────────────────────────────────────────────

interface PrSidebarUser {
  login: string;
  avatarUrl: string;
}

interface PrSidebarLabel {
  name: string;
  color: string;
}

function readUserList(
  detail: Record<string, unknown> | null,
  key: string
): PrSidebarUser[] {
  const value = detail?.[key];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.login !== "string" || !record.login) return [];
    return [
      {
        login: record.login,
        avatarUrl:
          typeof record.avatar_url === "string" ? record.avatar_url : "",
      },
    ];
  });
}

function readLabels(detail: Record<string, unknown> | null): PrSidebarLabel[] {
  const value = detail?.labels;
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name) return [];
    return [
      {
        name: record.name,
        color: typeof record.color === "string" ? record.color : "",
      },
    ];
  });
}

// ── Reviewer state rollup ────────────────────────────────────────────────────

type ReviewerState =
  | "awaiting"
  | "approved"
  | "changes_requested"
  | "commented";

interface ReviewerEntry extends PrSidebarUser {
  state: ReviewerState;
}

function isDecisive(state: string): boolean {
  return state === "APPROVED" || state === "CHANGES_REQUESTED";
}

/**
 * Latest meaningful review state per user: an approval or change request wins
 * over comment-only reviews (matching GitHub's sidebar), and a pending
 * re-request overrides any previous review state.
 */
function collectReviewerEntries(
  detail: Record<string, unknown> | null,
  reviews: GitHubPrReview[]
): ReviewerEntry[] {
  const latest = new Map<string, GitHubPrReview>();
  for (const review of reviews) {
    const login = review.user.login;
    if (!login || review.state === "PENDING") continue;
    const previous = latest.get(login);
    const newer =
      !previous || (review.submitted_at ?? "") >= (previous.submitted_at ?? "");
    if (!previous) {
      latest.set(login, review);
    } else if (isDecisive(review.state)) {
      if (!isDecisive(previous.state) || newer) latest.set(login, review);
    } else if (!isDecisive(previous.state) && newer) {
      latest.set(login, review);
    }
  }

  const entries = new Map<string, ReviewerEntry>();
  for (const [login, review] of latest) {
    entries.set(login, {
      login,
      avatarUrl: review.user.avatar_url,
      state:
        review.state === "APPROVED"
          ? "approved"
          : review.state === "CHANGES_REQUESTED"
            ? "changes_requested"
            : "commented",
    });
  }
  for (const reviewer of readRequestedReviewers(detail)) {
    entries.set(reviewer.login, {
      login: reviewer.login,
      avatarUrl: reviewer.avatar_url,
      state: "awaiting",
    });
  }
  return [...entries.values()];
}

function ReviewerStateIndicator({
  state,
}: {
  state: ReviewerState;
}): React.ReactNode {
  const { t } = useTranslation("common");
  switch (state) {
    case "approved":
      return (
        <span
          title={t("git.pr.activity.approved", "approved these changes")}
          className="inline-flex"
        >
          <Check size={14} strokeWidth={2} className="text-success-6" />
        </span>
      );
    case "changes_requested":
      return (
        <span
          title={t("git.pr.activity.changesRequested", "requested changes")}
          className="inline-flex"
        >
          <XCircle size={14} strokeWidth={1.9} className="text-danger-6" />
        </span>
      );
    case "awaiting":
      return (
        <span
          title={t("git.pr.sidebar.awaitingReview", "Awaiting review")}
          className="inline-flex h-2 w-2 rounded-full bg-warning-6"
        />
      );
    default:
      return (
        <span
          title={t("git.pr.activity.commented", "commented")}
          className="inline-flex"
        >
          <MessageCircle size={14} strokeWidth={1.9} className="text-text-3" />
        </span>
      );
  }
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

interface PrSidebarProps {
  identity: PrIdentity;
  detail: Record<string, unknown> | null;
  checks: GitHubChecksSummary | null;
  reviews: GitHubPrReview[];
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
  onDraftChange: (draft: boolean) => Promise<void>;
  onStateChange: (state: "open" | "closed") => Promise<void>;
  onRequestedReviewersChange: (reviewers: string[]) => Promise<void>;
  /** Repository members, unfiltered — the author may assign themselves. */
  assigneeCandidates: GitHubIssueUser[];
  onAssigneesChange: (logins: string[]) => Promise<void>;
  labelCandidates: GitHubIssueLabel[];
  loadingLabelCandidates: boolean;
  labelCandidatesError: string | null;
  onLoadLabelCandidates: () => Promise<void>;
  onLabelsChange: (names: string[]) => Promise<void>;
}

export const PrSidebar: React.FC<PrSidebarProps> = ({
  identity,
  detail,
  checks,
  reviews,
  disabled,
  pending,
  reviewerCandidates,
  loadingReviewerCandidates,
  reviewerCandidatesError,
  onLoadReviewerCandidates,
  onMerge,
  onSetAutoMerge,
  onDraftChange,
  onStateChange,
  onRequestedReviewersChange,
  assigneeCandidates,
  onAssigneesChange,
  labelCandidates,
  loadingLabelCandidates,
  labelCandidatesError,
  onLoadLabelCandidates,
  onLabelsChange,
}) => {
  const { t } = useTranslation("common");
  const [openPicker, setOpenPicker] = useState<
    "reviewers" | "assignees" | "labels" | null
  >(null);
  const presentation = presentPullRequestActions({
    detail,
    fallbackStatus: identity.status,
    checks,
  });
  const requestedReviewers = useMemo(
    () => readRequestedReviewers(detail),
    [detail]
  );
  const requestedReviewerLogins = requestedReviewers.map(
    (reviewer) => reviewer.login
  );
  const reviewerEntries = useMemo(
    () => collectReviewerEntries(detail, reviews),
    [detail, reviews]
  );
  const assignees = readUserList(detail, "assignees");
  const labels = readLabels(detail);

  const reviewerOptions = useMemo(() => {
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
  }, [requestedReviewers, reviewerCandidates]);

  const assigneeOptions = useMemo(() => {
    const unique = new Map<string, PrSidebarUser>();
    for (const person of [
      ...assignees,
      ...assigneeCandidates.map((candidate) => ({
        login: candidate.login,
        avatarUrl: candidate.avatar_url,
      })),
    ]) {
      unique.set(person.login.toLowerCase(), person);
    }
    return [...unique.values()].map((person) => ({
      value: person.login,
      label: (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar size={18} src={person.avatarUrl}>
            {person.login.charAt(0).toUpperCase()}
          </Avatar>
          <span className="truncate">{person.login}</span>
        </span>
      ),
      triggerLabel: person.login,
    }));
  }, [assignees, assigneeCandidates]);

  const labelOptions = useMemo(() => {
    const unique = new Map<string, PrSidebarLabel>();
    for (const label of [
      ...labels,
      ...labelCandidates.map((candidate) => ({
        name: candidate.name,
        color: candidate.color,
      })),
    ]) {
      unique.set(label.name.toLowerCase(), label);
    }
    return [...unique.values()].map((label) => ({
      value: label.name,
      label: (
        <span className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full bg-fill-3"
            style={
              label.color ? { backgroundColor: `#${label.color}` } : undefined
            }
          />
          <span className="truncate">{label.name}</span>
        </span>
      ),
      triggerLabel: label.name,
    }));
  }, [labels, labelCandidates]);

  // A draft is still an open pull request: GitHub accepts reviewer, assignee,
  // and label changes on it. Only merged and closed PRs are read-only here.
  const canEdit =
    (presentation.status === "open" || presentation.status === "draft") &&
    !disabled;

  /**
   * One trigger + panel for every rail picker, so reviewers, assignees, and
   * labels share their geometry, alignment, and empty/loading treatment.
   */
  const renderPicker = (config: {
    picker: "reviewers" | "assignees" | "labels";
    options: { value: string; label: React.ReactNode; triggerLabel: string }[];
    value: string[];
    loading: boolean;
    emptyContent: string;
    searchPlaceholder: string;
    triggerLabel: string;
    onLoad: () => Promise<void>;
    onChange: (next: string[]) => Promise<void>;
    successMessage: string;
    dataTestId: string;
  }): React.ReactNode => (
    <Dropdown
      options={config.options}
      value={config.value}
      mode="multiple"
      showSearch
      searchPlaceholder={config.searchPlaceholder}
      loading={config.loading}
      emptyContent={config.emptyContent}
      disabled={pending}
      popupVisible={openPicker === config.picker}
      onVisibleChange={(visible) => {
        setOpenPicker(visible ? config.picker : null);
        if (visible) void config.onLoad();
      }}
      getPopupContainer={() => document.body}
      avoidViewportOverflow
      // The trigger sits at the section's right edge, so the panel hangs from
      // that edge rather than running off the rail.
      position="bottom-end"
      className={`${DROPDOWN_CLASSES.panelAnimated} ${DROPDOWN_WIDTHS.fileTreeClass}`}
      onSelect={(value) => {
        const next = Array.isArray(value) ? value.map(String) : [String(value)];
        setOpenPicker(null);
        void reportPrAction(() => config.onChange(next), config.successMessage);
      }}
    >
      <WorkstationTrailIconButton
        disabled={pending}
        aria-label={config.triggerLabel}
        title={config.triggerLabel}
        data-testid={config.dataTestId}
      >
        <Settings size={14} strokeWidth={1.75} aria-hidden />
      </WorkstationTrailIconButton>
    </Dropdown>
  );

  const reviewerAction = canEdit
    ? renderPicker({
        picker: "reviewers",
        options: reviewerOptions,
        value: requestedReviewerLogins,
        loading: loadingReviewerCandidates,
        emptyContent: reviewerCandidatesError
          ? t("git.pr.actions.reviewersLoadFailed", "Could not load reviewers")
          : t("git.pr.actions.noReviewers", "No reviewers available"),
        searchPlaceholder: t(
          "git.pr.actions.searchReviewers",
          "Search reviewers"
        ),
        triggerLabel: t("git.pr.sidebar.requestReviewers", "Request reviewers"),
        onLoad: onLoadReviewerCandidates,
        onChange: onRequestedReviewersChange,
        successMessage: t(
          "git.pr.actions.reviewersUpdated",
          "Reviewers updated"
        ),
        dataTestId: "pr-reviewer-action",
      })
    : undefined;

  const assigneeAction = canEdit
    ? renderPicker({
        picker: "assignees",
        options: assigneeOptions,
        value: assignees.map((assignee) => assignee.login),
        loading: loadingReviewerCandidates,
        emptyContent: reviewerCandidatesError
          ? t("git.pr.sidebar.assigneesLoadFailed", "Could not load people")
          : t("git.pr.sidebar.noAssigneeCandidates", "No people available"),
        searchPlaceholder: t("git.pr.sidebar.searchAssignees", "Search people"),
        triggerLabel: t("git.pr.sidebar.editAssignees", "Edit assignees"),
        onLoad: onLoadReviewerCandidates,
        onChange: onAssigneesChange,
        successMessage: t(
          "git.pr.sidebar.assigneesUpdated",
          "Assignees updated"
        ),
        dataTestId: "pr-assignee-action",
      })
    : undefined;

  const labelAction = canEdit
    ? renderPicker({
        picker: "labels",
        options: labelOptions,
        value: labels.map((label) => label.name),
        loading: loadingLabelCandidates,
        emptyContent: labelCandidatesError
          ? t("git.pr.sidebar.labelsLoadFailed", "Could not load labels")
          : t("git.pr.sidebar.noLabelCandidates", "No labels available"),
        searchPlaceholder: t("git.pr.sidebar.searchLabels", "Search labels"),
        triggerLabel: t("git.pr.sidebar.editLabels", "Edit labels"),
        onLoad: onLoadLabelCandidates,
        onChange: onLabelsChange,
        successMessage: t("git.pr.sidebar.labelsUpdated", "Labels updated"),
        dataTestId: "pr-label-action",
      })
    : undefined;

  return (
    <WorkstationTrailSurface
      className="flex self-start"
      data-testid="pr-sidebar"
    >
      <WorkstationTrailBody
        className={`${WORKSTATION_TRAIL_CONTENT.sectionList} py-1`}
      >
        <WorkstationTrailSection
          title={t("git.pr.sidebar.reviewers", "Reviewers")}
          action={reviewerAction}
          dataTestId="pr-sidebar-reviewers"
        >
          {reviewerEntries.length > 0 ? (
            <ul className={WORKSTATION_TRAIL_CONTENT.rows}>
              {reviewerEntries.map((entry) => (
                <li
                  key={entry.login}
                  className={`${WORKSTATION_TRAIL_CONTENT.row} justify-between gap-2 pr-2`}
                >
                  <span
                    className={WORKSTATION_TRAIL_CONTENT.rowContent}
                    title={entry.login}
                  >
                    <Avatar size={18} src={entry.avatarUrl}>
                      {entry.login.charAt(0).toUpperCase()}
                    </Avatar>
                    <span className="truncate text-text-1">{entry.login}</span>
                  </span>
                  <ReviewerStateIndicator state={entry.state} />
                </li>
              ))}
            </ul>
          ) : (
            <WorkstationTrailEmptyText>
              {t("git.pr.sidebar.noReviews", "No reviews")}
            </WorkstationTrailEmptyText>
          )}
        </WorkstationTrailSection>

        <WorkstationTrailSection
          title={t("git.pr.sidebar.assignees", "Assignees")}
          action={assigneeAction}
          dataTestId="pr-sidebar-assignees"
        >
          {assignees.length > 0 ? (
            <ul className={WORKSTATION_TRAIL_CONTENT.rows}>
              {assignees.map((assignee) => (
                <li
                  key={assignee.login}
                  className={WORKSTATION_TRAIL_CONTENT.row}
                >
                  <span
                    className={WORKSTATION_TRAIL_CONTENT.rowContent}
                    title={assignee.login}
                  >
                    <Avatar size={18} src={assignee.avatarUrl}>
                      {assignee.login.charAt(0).toUpperCase()}
                    </Avatar>
                    <span className="truncate text-text-1">
                      {assignee.login}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <WorkstationTrailEmptyText>
              {t("git.pr.sidebar.noAssignees", "No one assigned")}
            </WorkstationTrailEmptyText>
          )}
        </WorkstationTrailSection>

        <WorkstationTrailSection
          title={t("git.pr.sidebar.labels", "Labels")}
          action={labelAction}
          dataTestId="pr-sidebar-labels"
        >
          {labels.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 px-2">
              {labels.map((label) => (
                <span
                  key={label.name}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border-2 px-2 py-0.5 text-[11px] text-text-1"
                  title={label.name}
                >
                  {label.color ? (
                    <span
                      aria-hidden
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: `#${label.color}` }}
                    />
                  ) : null}
                  <span className="truncate">{label.name}</span>
                </span>
              ))}
            </div>
          ) : (
            <WorkstationTrailEmptyText>
              {t("git.pr.sidebar.noLabels", "None yet")}
            </WorkstationTrailEmptyText>
          )}
        </WorkstationTrailSection>

        <WorkstationTrailSection
          title={t("git.pr.sidebar.actions", "Actions")}
          dataTestId="pr-sidebar-actions"
        >
          <div className="px-1 pb-0.5">
            <PrLevelActions
              identity={identity}
              detail={detail}
              checks={checks}
              disabled={disabled}
              pending={pending}
              onMerge={onMerge}
              onSetAutoMerge={onSetAutoMerge}
              onDraftChange={onDraftChange}
              onStateChange={onStateChange}
            />
          </div>
        </WorkstationTrailSection>
      </WorkstationTrailBody>
    </WorkstationTrailSurface>
  );
};

PrSidebar.displayName = "PrSidebar";
