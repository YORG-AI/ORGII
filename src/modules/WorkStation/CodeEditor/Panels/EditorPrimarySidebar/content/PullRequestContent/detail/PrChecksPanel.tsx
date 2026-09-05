/**
 * PrChecksPanel
 *
 * Contents of the floating checks panel hung off the merge-status rail: a
 * header naming the rolled-up verdict, then every check on the head commit
 * grouped worst-first so a failure never needs scrolling to. Purely
 * presentational — the caller owns the portal, the positioning, and the
 * open/close lifecycle.
 */
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { GitHubChecksSummary } from "@src/api/tauri/github";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import { ArrowUpRight01Icon, HugeiconsIcon, ListChecksIcon } from "@src/icons";
import CiCheckStateIcon from "@src/modules/shared/components/CiCheckStateIcon";
import {
  CI_CHECK_SECTION_ORDER,
  type CiCheckItem,
  type CiCheckState,
  countCheckStates,
  flattenChecks,
} from "@src/services/git/ciCheckState";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";
import { classNames } from "@src/util/ui/classNames";

interface PrCheckRowProps {
  item: CiCheckItem;
  onOpenDetails: (url: string) => void;
}

function PrCheckRow({ item, onOpenDetails }: PrCheckRowProps): React.ReactNode {
  const { t } = useTranslation("common");
  // Elapsed time only earns space while a check is still running — once it has
  // a verdict, the verdict is the answer. Same rule as the status-bar CI menu,
  // so the two panels read alike.
  const meta =
    item.state === "pending" && item.startedAt
      ? formatRelativeTime(item.startedAt, "nano")
      : null;
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
          <CiCheckStateIcon state={item.state} size={DROPDOWN_ITEM.iconSize} />
        </span>
        <span className="min-w-0 flex-1 truncate text-text-1" title={title}>
          {item.name}
        </span>
        {meta ? (
          <span className="shrink-0 text-text-3 tabular-nums">{meta}</span>
        ) : null}
      </div>
      {item.detailsUrl ? (
        <button
          type="button"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1"
          title={t("workstation.ci.viewDetails", "View check details")}
          aria-label={t("workstation.ci.viewDetails", "View check details")}
          onClick={(event) => {
            event.stopPropagation();
            onOpenDetails(item.detailsUrl as string);
          }}
        >
          <HugeiconsIcon
            icon={ArrowUpRight01Icon}
            data-icon="arrow-up-right"
            size={DROPDOWN_ITEM.iconSize}
          />
        </button>
      ) : null}
    </div>
  );
}

export interface PrChecksPanelProps {
  checks: GitHubChecksSummary | null;
  onOpenDetails: (url: string) => void;
}

export function PrChecksPanel({
  checks,
  onOpenDetails,
}: PrChecksPanelProps): React.ReactNode {
  const { t } = useTranslation("common");
  const items = useMemo(() => flattenChecks(checks), [checks]);
  const counts = useMemo(() => countCheckStates(items), [items]);
  const sections = useMemo(
    () =>
      CI_CHECK_SECTION_ORDER.map((state) => ({
        state,
        items: items.filter((item) => item.state === state),
      })).filter((section) => section.items.length > 0),
    [items]
  );

  const sectionLabel = (state: CiCheckState, count: number): string => {
    const label =
      state === "failure"
        ? t("workstation.ci.sections.failed", "Failed")
        : state === "pending"
          ? t("workstation.ci.sections.running", "Running")
          : state === "neutral"
            ? t("workstation.ci.sections.skipped", "Skipped")
            : t("workstation.ci.sections.passed", "Passed");
    return `${label} · ${count}`;
  };

  return (
    <>
      <div
        className={classNames(
          DROPDOWN_CLASSES.panelHeaderRow,
          DROPDOWN_ITEM.fontSizeClass
        )}
      >
        <HugeiconsIcon
          icon={ListChecksIcon}
          data-icon="list-checks"
          size={DROPDOWN_ITEM.iconSize}
          className="shrink-0 text-text-3"
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-text-1">
          {t("git.pr.tabs.checks", "Checks")}
        </span>
        {counts.total > 0 ? (
          <span className="shrink-0 text-text-3 tabular-nums">
            {`${counts.success}/${counts.total}`}
          </span>
        ) : null}
      </div>

      <div className={DROPDOWN_CLASSES.optionsContainerBelowHeader}>
        {sections.length === 0 ? (
          <div className={DROPDOWN_CLASSES.listMessage}>
            {t("git.pr.checks.none", "No checks reported")}
          </div>
        ) : (
          sections.map((section) => (
            <React.Fragment key={section.state}>
              <div className={DROPDOWN_CLASSES.sectionLabel}>
                {sectionLabel(section.state, section.items.length)}
              </div>
              {section.items.map((item) => (
                <PrCheckRow
                  key={item.key}
                  item={item}
                  onOpenDetails={onOpenDetails}
                />
              ))}
            </React.Fragment>
          ))
        )}
      </div>
    </>
  );
}

PrChecksPanel.displayName = "PrChecksPanel";
