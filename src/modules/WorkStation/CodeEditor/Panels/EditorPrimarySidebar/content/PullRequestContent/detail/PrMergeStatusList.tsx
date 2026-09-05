/**
 * PrMergeStatusList
 *
 * GitHub's merge box, folded into the PR operations rail: a headline verdict
 * ("Able to merge", "Merging is blocked", …) over the conditions behind it —
 * checks, review decision, conflicts, auto-merge. The checks row is a trigger
 * that opens a floating panel listing every check on the head commit, so the
 * rail answers "what is red?" without a trip to the Checks tab or the browser.
 *
 * The verdict itself comes from `summarizePullRequestMergeStatus`; this file
 * only maps its identifiers to wording and glyphs.
 */
import type { TFunction } from "i18next";
import React, { useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type {
  GitHubChecksSummary,
  GitHubPrReview,
} from "@src/api/tauri/github";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { useDropdownEngine } from "@src/hooks/dropdown";
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  HugeiconsIcon,
  Loading03Icon,
} from "@src/icons";
import CiCheckStateIcon from "@src/modules/shared/components/CiCheckStateIcon";
import {
  type PrMergeHeadlineKind,
  type PrMergeStatusRow,
  type PrMergeStatusTone,
  summarizePullRequestMergeStatus,
} from "@src/shared/pr/prMergeStatus";
import type { PrIdentity } from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";
import { openExternalLink } from "@src/util/platform/ipcRenderer";

import { PrChecksPanel } from "./PrChecksPanel";

// Same row shape and 12px/text-text-1 label color as every other status row
// in this sidebar (PrChecksTab's CheckRow, PrSidebar's reviewer/assignee
// rows) — tone lives on the icon alone, and no row is bolder than its
// siblings, so the headline reads as one item in the same list rather than
// a differently-styled banner above it.
const ROW_CLASS =
  "flex h-6 w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-[12px] text-text-1";

/** Tone color for the headline's icon only — row text never carries tone. */
const TONE_TEXT_CLASS: Record<PrMergeStatusTone, string> = {
  success: "text-success-6",
  failure: "text-danger-6",
  pending: "text-warning-6",
  neutral: "text-text-3",
};

const HEADLINE_ICONS: Record<
  PrMergeHeadlineKind,
  { icon: typeof GitMergeIcon; dataIcon: string; spin?: boolean }
> = {
  ableToMerge: { icon: GitMergeIcon, dataIcon: "git-merge" },
  merged: { icon: GitMergeIcon, dataIcon: "git-merge" },
  queued: { icon: GitMergeIcon, dataIcon: "git-merge" },
  blocked: { icon: AlertCircleIcon, dataIcon: "alert-circle" },
  conflicts: { icon: AlertCircleIcon, dataIcon: "alert-circle" },
  draft: { icon: GitPullRequestDraftIcon, dataIcon: "git-pull-request-draft" },
  closed: {
    icon: GitPullRequestClosedIcon,
    dataIcon: "git-pull-request-closed",
  },
  checking: { icon: Loading03Icon, dataIcon: "loader", spin: true },
};

const HEADLINE_LABELS: Record<PrMergeHeadlineKind, string> = {
  ableToMerge: "Able to merge",
  blocked: "Merging is blocked",
  conflicts: "Merge conflicts",
  queued: "Queued to merge",
  draft: "Draft — not ready to merge",
  merged: "Pull request merged",
  closed: "Pull request closed",
  checking: "Checking mergeability…",
};

const ROW_LABELS: Record<PrMergeStatusRow["kind"], string> = {
  checksPassed: "All checks have passed",
  checksFailing: "{{count}} failing checks",
  checksRunning: "{{count}} checks in progress",
  checksSkipped: "{{count}} checks skipped",
  checksNone: "No checks reported",
  reviewApproved: "Changes approved",
  reviewRequired: "Review required",
  reviewChangesRequested: "Changes requested",
  noConflicts: "No conflicts with the base branch",
  hasConflicts: "Conflicts with the base branch",
  outOfDate: "Out of date with the base branch",
  checkingConflicts: "Checking for conflicts…",
  autoMergeEnabled: "Auto-merge enabled",
  inMergeQueue: "Waiting in the merge queue",
};

/** Singular forms for the rows that name a count. */
const ROW_LABELS_ONE: Partial<Record<PrMergeStatusRow["kind"], string>> = {
  checksFailing: "{{count}} failing check",
  checksRunning: "{{count}} check in progress",
  checksSkipped: "{{count}} check skipped",
};

function rowLabel(t: TFunction, row: PrMergeStatusRow): string {
  const key = `git.pr.mergeStatus.${row.kind}`;
  if (row.count === undefined) return t(key, ROW_LABELS[row.kind]);
  return t(key, {
    count: row.count,
    defaultValue: ROW_LABELS_ONE[row.kind] ?? ROW_LABELS[row.kind],
    defaultValue_other: ROW_LABELS[row.kind],
  });
}

interface PrMergeStatusListProps {
  identity: PrIdentity;
  detail: Record<string, unknown> | null;
  checks: GitHubChecksSummary | null;
  reviews: readonly GitHubPrReview[];
}

export const PrMergeStatusList: React.FC<PrMergeStatusListProps> = ({
  identity,
  detail,
  checks,
  reviews,
}) => {
  const { t } = useTranslation("common");
  const summary = useMemo(
    () =>
      summarizePullRequestMergeStatus({
        checks,
        detail,
        fallbackStatus: identity.status,
        reviews,
      }),
    [checks, detail, identity.status, reviews]
  );

  const {
    close,
    isOpen,
    isPositioned,
    panelPosition,
    panelRef,
    toggle,
    triggerRef,
  } = useDropdownEngine<HTMLDivElement>({
    align: "right",
    gap: DROPDOWN_PANEL.triggerGap,
    placement: "auto",
  });

  const handleOpenDetails = useCallback(
    (url: string) => {
      void openExternalLink(url);
      close();
    },
    [close]
  );

  const headlineIcon = HEADLINE_ICONS[summary.headline];

  return (
    <section
      className="flex w-full flex-col gap-0.5"
      aria-label={t("git.pr.mergeStatus.label", "Merge status")}
      data-testid="pr-merge-status"
    >
      <div className={ROW_CLASS} data-testid="pr-merge-status-headline">
        <HugeiconsIcon
          icon={headlineIcon.icon}
          data-icon={headlineIcon.dataIcon}
          size={14}
          strokeWidth={1.9}
          className={`shrink-0 ${TONE_TEXT_CLASS[summary.headlineTone]} ${headlineIcon.spin ? "animate-spin" : ""}`.trim()}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">
          {t(
            `git.pr.mergeStatus.${summary.headline}`,
            HEADLINE_LABELS[summary.headline]
          )}
        </span>
      </div>

      {summary.rows.map((row) => {
        const label = rowLabel(t, row);
        if (!row.expandable) {
          return (
            <div key={row.kind} className={ROW_CLASS} title={label}>
              <CiCheckStateIcon state={row.tone} size={13} />
              <span className="min-w-0 flex-1 truncate">{label}</span>
            </div>
          );
        }
        return (
          // A stable key across verdict changes, so the anchor element the open
          // panel is positioned against survives a check flipping red.
          <div key="checks" ref={triggerRef} className="w-full">
            <button
              type="button"
              className={`${ROW_CLASS} transition-colors hover:bg-fill-1 hover:text-text-1`}
              aria-expanded={isOpen}
              aria-haspopup="dialog"
              title={t("git.pr.mergeStatus.viewChecks", "View all checks")}
              onClick={toggle}
              data-testid="pr-merge-status-checks"
            >
              <CiCheckStateIcon state={row.tone} size={13} />
              <span className="min-w-0 flex-1 truncate text-left">{label}</span>
              <HugeiconsIcon
                icon={isOpen ? ArrowDown01Icon : ArrowRight01Icon}
                data-icon={isOpen ? "chevron-down" : "chevron-right"}
                size={12}
                strokeWidth={1.9}
                className="shrink-0 text-text-3"
                aria-hidden
              />
            </button>
          </div>
        );
      })}

      {isOpen &&
        isPositioned &&
        createPortal(
          <div
            ref={panelRef}
            className={`${DROPDOWN_CLASSES.menuPanelWithHeaderBase} ${DROPDOWN_WIDTHS.fixedStatusPanelClass} flex flex-col`}
            style={{
              position: "fixed",
              top: panelPosition.top,
              bottom: panelPosition.bottom,
              // Right-aligned panels are placed from the trigger's right
              // edge only — emitting `left` alongside `right` here (with
              // this panel's fixed width) over-constrains the CSS box, so
              // the browser drops `right` and the panel renders left-
              // anchored instead. Same convention as ProjectsTab,
              // AddActionsButton, SidebarGuideButton, SettingsSearchDropdown.
              left:
                panelPosition.right === undefined
                  ? panelPosition.left
                  : undefined,
              right: panelPosition.right,
              maxHeight: panelPosition.maxHeight,
            }}
            role="dialog"
            aria-label={t("git.pr.tabs.checks", "Checks")}
            data-testid="pr-merge-status-checks-panel"
          >
            <PrChecksPanel checks={checks} onOpenDetails={handleOpenDetails} />
          </div>,
          document.body
        )}
    </section>
  );
};

PrMergeStatusList.displayName = "PrMergeStatusList";
