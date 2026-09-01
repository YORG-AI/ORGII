/**
 * Branch CI status-bar menu: the pull request opened for the current branch
 * and the state of every check on its head commit.
 *
 * Shares the ports menu's shape — a status-bar trigger plus a portalled panel
 * with a header row and grouped rows — so the two neighbours in the bar read
 * as one control family.
 *
 * Polling is deliberately conservative: `useBranchPullRequestStatus({ poll })`
 * stops asking once every check has reported, and opening the menu forces a
 * fresh read.
 */
import React, { memo, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { useActiveRepoRef } from "@src/hooks/git/useActiveRepoRef";
import { useBranchPullRequestStatus } from "@src/hooks/git/useBranchPullRequestStatus";
import {
  ArrowUpRight01Icon,
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  CircleDashedIcon,
  CircleSlashIcon,
  GitPullRequestIcon,
  HugeiconsIcon,
  Loading03Icon,
  Refresh04Icon,
} from "@src/icons";
import type { BranchCiStatus } from "@src/services/git/branchPullRequestStatus";
import {
  type CiCheckItem,
  type CiCheckState,
  countCheckStates,
  flattenChecks,
} from "@src/services/git/ciCheckState";
import { openExternalLink } from "@src/util/platform/ipcRenderer";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";
import { classNames } from "@src/util/ui/classNames";

import { StatusBarButton, StatusBarLabel } from "./StatusBarBase";
import { StatusBarTooltip } from "./StatusBarTooltip";

const MENU_ICON_SIZE = DROPDOWN_ITEM.iconSize;

/** Order the panel sections worst-first, so failures never need scrolling to. */
const SECTION_ORDER: CiCheckState[] = [
  "failure",
  "pending",
  "neutral",
  "success",
];

interface CiStatusMenuProps {
  branchName?: string;
  headRevision?: string;
}

function CheckStateIcon({
  state,
  size = MENU_ICON_SIZE,
}: {
  state: CiCheckState;
  size?: number;
}): React.ReactNode {
  switch (state) {
    case "success":
      return (
        <HugeiconsIcon
          icon={CheckmarkCircle01Icon}
          data-icon="check-circle-2"
          size={size}
          strokeWidth={1.9}
          className="text-success-6"
        />
      );
    case "failure":
      return (
        <HugeiconsIcon
          icon={CancelCircleIcon}
          data-icon="xcircle"
          size={size}
          strokeWidth={1.9}
          className="text-danger-6"
        />
      );
    case "pending":
      return (
        <HugeiconsIcon
          icon={Loading03Icon}
          data-icon="loader"
          size={size}
          strokeWidth={1.9}
          className="animate-spin text-warning-6"
        />
      );
    default:
      return (
        <HugeiconsIcon
          icon={CircleSlashIcon}
          data-icon="circle-slash"
          size={size}
          strokeWidth={1.9}
          className="text-text-3"
        />
      );
  }
}

function BranchCiIcon({ status }: { status: BranchCiStatus }): React.ReactNode {
  switch (status) {
    case "success":
      return <CheckStateIcon state="success" size={13} />;
    case "failure":
      return <CheckStateIcon state="failure" size={13} />;
    case "pending":
    case "checking":
      return <CheckStateIcon state="pending" size={13} />;
    default:
      return (
        <HugeiconsIcon
          icon={CircleDashedIcon}
          data-icon="circle-dashed"
          size={13}
          strokeWidth={1.9}
          className="text-text-3"
        />
      );
  }
}

interface CheckRowProps {
  item: CiCheckItem;
  onOpenDetails: (url: string) => void;
}

const CheckRow: React.FC<CheckRowProps> = memo(({ item, onOpenDetails }) => {
  const { t } = useTranslation();
  // Elapsed time only earns space while a check is still running — once it has
  // a verdict, the verdict is the answer and "35m ago" is noise.
  const meta =
    item.state === "pending" && item.startedAt
      ? formatRelativeTime(item.startedAt, "nano")
      : null;
  // The reporting app is the same for nearly every row, so it only earns the
  // narrow status-bar width in the hover title, not in the label.
  const title = [
    item.appName ? `${item.appName} / ${item.name}` : item.name,
    item.description,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className={DROPDOWN_CLASSES.menuControlItem}>
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <span className="shrink-0">
          <CheckStateIcon state={item.state} />
        </span>
        <span className="min-w-0 flex-1 truncate text-text-1" title={title}>
          {item.name}
        </span>
        {meta && (
          <span className="shrink-0 text-text-3 tabular-nums">{meta}</span>
        )}
      </div>
      {/*
        Actions stay painted rather than revealed on hover — same reasoning as
        the ports rows: opacity transitions promote compositor layers and make
        the centered icon jitter in Chromium.
      */}
      <div className="flex shrink-0 items-center gap-0.5">
        {item.detailsUrl && (
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1"
            title={t("workstation.ci.viewDetails")}
            aria-label={t("workstation.ci.viewDetails")}
            onClick={(event) => {
              event.stopPropagation();
              onOpenDetails(item.detailsUrl as string);
            }}
          >
            <HugeiconsIcon
              icon={ArrowUpRight01Icon}
              data-icon="arrow-up-right"
              size={MENU_ICON_SIZE}
            />
          </button>
        )}
      </div>
    </div>
  );
});
CheckRow.displayName = "CheckRow";

export const CiStatusMenu: React.FC<CiStatusMenuProps> = memo(
  ({ branchName, headRevision }) => {
    const { t } = useTranslation();
    const { repoId, repoPath } = useActiveRepoRef();

    const { checks, ciStatus, pr, refresh, refreshing } =
      useBranchPullRequestStatus({
        branchName,
        headRevision,
        repoId,
        repoPath,
        poll: true,
      });

    const {
      close,
      isOpen,
      isPositioned,
      panelPosition,
      panelRef,
      toggle,
      triggerRef,
    } = useDropdownEngine<HTMLDivElement>({
      align: "left",
      gap: DROPDOWN_PANEL.triggerGap,
      placement: "top",
    });

    const items = useMemo(() => flattenChecks(checks), [checks]);
    const counts = useMemo(() => countCheckStates(items), [items]);

    const sections = useMemo(
      () =>
        SECTION_ORDER.map((state) => ({
          state,
          items: items.filter((item) => item.state === state),
        })).filter((section) => section.items.length > 0),
      [items]
    );

    const handleToggle = useCallback(() => {
      // Opening is the user asking "where is it now?" — always re-read, even
      // when the background schedule has already settled and stopped.
      if (!isOpen) refresh();
      toggle();
    }, [isOpen, refresh, toggle]);

    const handleOpenDetails = useCallback(
      (url: string) => {
        void openExternalLink(url);
        close();
      },
      [close]
    );

    const handleOpenPullRequest = useCallback(() => {
      if (!pr) return;
      void openExternalLink(pr.url);
      close();
    }, [close, pr]);

    const statusLabel = useMemo(() => {
      switch (ciStatus) {
        case "success":
          return t("git.pr.checks.passedShort");
        case "failure":
          return t("git.pr.checks.failedShort");
        case "pending":
          return t("git.pr.checks.runningShort");
        case "checking":
          return t("git.pr.checks.checkingShort");
        case "none":
          return t("git.pr.checks.noneShort");
        default:
          return t("git.pr.checks.unavailableShort");
      }
    }, [ciStatus, t]);

    const sectionLabelFor = useCallback(
      (state: CiCheckState, count: number) => {
        const label =
          state === "failure"
            ? t("workstation.ci.sections.failed")
            : state === "pending"
              ? t("workstation.ci.sections.running")
              : state === "neutral"
                ? t("workstation.ci.sections.skipped")
                : t("workstation.ci.sections.passed");
        return `${label} · ${count}`;
      },
      [t]
    );

    // Nothing to trace without an open pull request for this branch — the
    // compare/create affordances live in the git sync menu next door.
    if (!pr || !ciStatus) return null;

    const reportedCount = counts.total - counts.pending;
    const triggerLabel =
      counts.pending > 0
        ? `#${pr.number} · ${reportedCount}/${counts.total}`
        : `#${pr.number}`;
    const triggerTooltip = t("git.pr.checks.branchStatus", {
      number: pr.number,
      status: statusLabel,
    });

    return (
      <div ref={triggerRef} className="flex h-full">
        <StatusBarTooltip label={triggerTooltip} disabled={isOpen}>
          <StatusBarButton
            onClick={handleToggle}
            active={isOpen}
            ariaLabel={triggerTooltip}
            className="gap-1.5"
            dataTestId="status-bar-ci"
          >
            <BranchCiIcon status={ciStatus} />
            <StatusBarLabel emphasis numeric className="text-text-1">
              {triggerLabel}
            </StatusBarLabel>
          </StatusBarButton>
        </StatusBarTooltip>

        {isOpen &&
          isPositioned &&
          createPortal(
            <div
              ref={panelRef}
              className={`${DROPDOWN_CLASSES.menuPanelWithHeaderBase} ${DROPDOWN_WIDTHS.fixedStatusPanelClass}`}
              style={{
                position: "fixed",
                top: panelPosition.top,
                bottom: panelPosition.bottom,
                left: panelPosition.left,
                right: panelPosition.right,
              }}
              role="menu"
            >
              {/*
                The header row token carries no font size — the search variant
                gets it from the input instead. Set it here so the title and
                status read at the same 13px as the check rows below rather
                than inheriting the document default.
              */}
              <div
                className={classNames(
                  DROPDOWN_CLASSES.panelHeaderRow,
                  DROPDOWN_ITEM.fontSizeClass
                )}
              >
                <HugeiconsIcon
                  icon={GitPullRequestIcon}
                  data-icon="git-pull-request"
                  size={MENU_ICON_SIZE}
                  className="shrink-0 text-text-3"
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-text-1 hover:underline"
                  title={t("workstation.ci.openPullRequest")}
                  onClick={handleOpenPullRequest}
                >
                  {t("git.pr.linkedBranch", { number: pr.number })}
                </button>
                <span className="shrink-0 text-text-3">{statusLabel}</span>
                <button
                  type="button"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1"
                  title={t("workstation.ci.refresh")}
                  aria-label={t("workstation.ci.refresh")}
                  onClick={refresh}
                >
                  <HugeiconsIcon
                    icon={Refresh04Icon}
                    data-icon="refresh-cw"
                    size={MENU_ICON_SIZE}
                    className={classNames(refreshing && "animate-spin")}
                  />
                </button>
              </div>

              <div className={DROPDOWN_CLASSES.optionsContainerBelowHeader}>
                {sections.length === 0 ? (
                  <div className={DROPDOWN_CLASSES.listMessage}>
                    {ciStatus === "unavailable"
                      ? t("workstation.ci.unavailable")
                      : ciStatus === "checking"
                        ? t("git.pr.checks.checkingShort")
                        : t("git.pr.checks.none")}
                  </div>
                ) : (
                  sections.map((section) => (
                    <React.Fragment key={section.state}>
                      <div className={DROPDOWN_CLASSES.sectionLabel}>
                        {sectionLabelFor(section.state, section.items.length)}
                      </div>
                      {section.items.map((item) => (
                        <CheckRow
                          key={item.key}
                          item={item}
                          onOpenDetails={handleOpenDetails}
                        />
                      ))}
                    </React.Fragment>
                  ))
                )}
              </div>
            </div>,
            document.body
          )}
      </div>
    );
  }
);
CiStatusMenu.displayName = "CiStatusMenu";

export default CiStatusMenu;
