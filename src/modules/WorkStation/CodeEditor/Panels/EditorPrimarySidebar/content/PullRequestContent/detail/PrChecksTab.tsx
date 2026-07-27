/**
 * PrChecksTab
 *
 * CI status for a PR's head commit: modern check-runs + legacy commit statuses
 * from `github_get_checks`, grouped by outcome with a rolled-up summary line.
 */
import {
  CheckCircle2,
  CircleSlash,
  ExternalLink,
  Loader,
  XCircle,
} from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import type {
  GitHubCheckRun,
  GitHubChecksSummary,
  GitHubStatusContext,
} from "@src/api/tauri/github";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { formatTimeAgo } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/hooks/workstationIssueHelpers";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

type CheckState = "success" | "failure" | "pending" | "neutral";

function checkRunState(run: GitHubCheckRun): CheckState {
  if (run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
    case "action_required":
    case "cancelled":
    case "startup_failure":
      return "failure";
    case "neutral":
    case "skipped":
    case "stale":
      return "neutral";
    default:
      return "pending";
  }
}

function statusState(status: GitHubStatusContext): CheckState {
  switch (status.state) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    case "pending":
      return "pending";
    default:
      return "neutral";
  }
}

function StateIcon({ state }: { state: CheckState }): React.ReactNode {
  switch (state) {
    case "success":
      return (
        <CheckCircle2 size={15} strokeWidth={1.9} className="text-success-6" />
      );
    case "failure":
      return <XCircle size={15} strokeWidth={1.9} className="text-danger-6" />;
    case "pending":
      return (
        <Loader
          size={15}
          strokeWidth={1.9}
          className="animate-spin text-warning-6"
        />
      );
    default:
      return (
        <CircleSlash size={15} strokeWidth={1.9} className="text-text-3" />
      );
  }
}

interface CheckRowProps {
  state: CheckState;
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
          title="Details"
        >
          <ExternalLink size={13} strokeWidth={1.9} />
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

  const overall = (checks?.state ?? "pending") as CheckState;
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
              state={statusState(status)}
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
