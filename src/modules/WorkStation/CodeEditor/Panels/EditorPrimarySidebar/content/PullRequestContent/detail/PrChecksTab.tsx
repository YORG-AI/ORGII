/**
 * PrChecksTab
 *
 * CI status for a PR's head commit: modern check-runs + legacy commit statuses
 * from `github_get_checks`, grouped by outcome with a rolled-up summary line.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import type { GitHubChecksSummary } from "@src/api/tauri/github";
import { Placeholder } from "@src/components/Placeholder";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import {
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  CircleSlashIcon,
  HugeiconsIcon,
  Loading01Icon,
  SquareArrowUpRightIcon,
} from "@src/icons";
import { formatTimeAgo } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/hooks/workstationIssueHelpers";
import {
  type CiCheckState,
  checkRunState,
  statusContextState,
} from "@src/services/git/ciCheckState";

function StateIcon({ state }: { state: CiCheckState }): React.ReactNode {
  switch (state) {
    case "success":
      return (
        <HugeiconsIcon
          icon={CheckmarkCircle01Icon}
          data-icon="check-circle-2"
          size={15}
          strokeWidth={1.9}
          className="text-success-6"
        />
      );
    case "failure":
      return (
        <HugeiconsIcon
          icon={CancelCircleIcon}
          data-icon="xcircle"
          size={15}
          strokeWidth={1.9}
          className="text-danger-6"
        />
      );
    case "pending":
      return (
        <HugeiconsIcon
          icon={Loading01Icon}
          data-icon="loader"
          size={15}
          strokeWidth={1.9}
          className="animate-spin text-warning-6"
        />
      );
    default:
      return (
        <HugeiconsIcon
          icon={CircleSlashIcon}
          data-icon="circle-slash"
          size={15}
          strokeWidth={1.9}
          className="text-text-3"
        />
      );
  }
}

interface CheckRowProps {
  state: CiCheckState;
  name: string;
  description?: string | null;
  meta?: string | null;
  detailsUrl?: string | null;
}

function CheckRow({
  state,
  name,
  description,
  meta,
  detailsUrl,
}: CheckRowProps): React.ReactNode {
  const { t } = useTranslation("common");
  return (
    <div className="flex min-w-0 items-center gap-2.5 border-b border-border-1 px-3 py-2 last:border-b-0">
      <span className="shrink-0">
        <StateIcon state={state} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] text-text-1" title={name}>
          {name}
        </div>
        {description ? (
          <div className="truncate text-[11px] text-text-3" title={description}>
            {description}
          </div>
        ) : null}
      </div>
      {meta ? (
        <span className="shrink-0 text-[11px] text-text-3">{meta}</span>
      ) : null}
      {detailsUrl ? (
        <a
          href={detailsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-text-3 hover:text-text-1"
          title={t("git.pr.details", "Details")}
        >
          <HugeiconsIcon
            icon={SquareArrowUpRightIcon}
            data-icon="square-arrow-out-up-right"
            size={13}
            strokeWidth={1.9}
          />
        </a>
      ) : null}
    </div>
  );
}

interface PrChecksTabProps {
  checks: GitHubChecksSummary | null;
  loading: boolean;
}

export const PrChecksTab: React.FC<PrChecksTabProps> = ({
  checks,
  loading,
}) => {
  const { t } = useTranslation("common");

  if (loading && !checks) {
    return (
      <Placeholder variant="loading" placement="sidebar" fillParentHeight />
    );
  }

  const runs = checks?.check_runs ?? [];
  const statuses = checks?.statuses ?? [];

  if (runs.length === 0 && statuses.length === 0) {
    return (
      <Placeholder
        variant="empty"
        placement="sidebar"
        title={t("git.pr.checks.none", "No checks reported")}
        subtitle={t(
          "git.pr.checks.noneHint",
          "No CI checks or statuses ran on this pull request's head commit."
        )}
        fillParentHeight
      />
    );
  }

  const overall = (checks?.state ?? "pending") as CiCheckState;
  const summaryLabel =
    overall === "success"
      ? t("git.pr.checks.allPassed", "All checks passed")
      : overall === "failure"
        ? t("git.pr.checks.someFailed", "Some checks failed")
        : t("git.pr.checks.pending", "Checks in progress");

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
      <div className={`${DETAIL_PANEL_TOKENS.headerWidth} px-4 py-4`}>
        <div className="mb-3 flex items-center gap-2">
          <StateIcon state={overall} />
          <span className="text-[13px] font-medium text-text-1">
            {summaryLabel}
          </span>
        </div>

        <div className="overflow-hidden rounded-xl border border-border-1">
          {runs.map((run) => (
            <CheckRow
              key={`run-${run.id}`}
              state={checkRunState(run)}
              name={run.app_name ? `${run.app_name} / ${run.name}` : run.name}
              description={run.output_title}
              meta={
                run.completed_at
                  ? formatTimeAgo(run.completed_at)
                  : run.started_at
                    ? formatTimeAgo(run.started_at)
                    : null
              }
              detailsUrl={run.details_url}
            />
          ))}
          {statuses.map((status) => (
            <CheckRow
              key={`status-${status.context}`}
              state={statusContextState(status)}
              name={status.context}
              description={status.description}
              detailsUrl={status.target_url}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

PrChecksTab.displayName = "PrChecksTab";
