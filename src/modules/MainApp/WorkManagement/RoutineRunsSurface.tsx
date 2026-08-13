/**
 * RoutineRunsSurface
 *
 * The Runs navigation surface (orgtrack/v1 §7.2): rows from
 * `pm_routine_runs`, newest first, each expandable into the run's
 * generated WorkItem graph with portable states. Status comes from the
 * durable ordered projection (`project_routine_run_status`), not from a
 * cached copy — a run whose items moved since the row was written shows
 * its recomputed status once expanded.
 */
import { ChevronDown, ChevronRight, PlayCircle, RefreshCw } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type RoutineRunStatus,
  type RoutineRunSummary,
  projectApi,
} from "@src/api/http/project";
import Button from "@src/components/Button";
import Message from "@src/components/Message";
import { useRoutineResultNavigation } from "@src/hooks/navigation";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

const STATUS_TONE: Record<string, string> = {
  succeeded: "text-success-6",
  failed: "text-danger-6",
  running: "text-primary-6",
  pending: "text-text-3",
  cancelled: "text-text-3",
};

const RunStatusLabel: React.FC<{ status: string }> = ({ status }) => (
  <span
    className={`text-[12px] font-medium ${STATUS_TONE[status] ?? "text-text-2"}`}
  >
    {status}
  </span>
);

interface RunRowProps {
  run: RoutineRunSummary;
}

const RunRow: React.FC<RunRowProps> = ({ run }) => {
  const { t } = useTranslation("sessions");
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<RoutineRunStatus | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const openResult = useRoutineResultNavigation();

  const openWorkItem = useCallback(
    (workItemId: string) => {
      void openResult({
        workItemId,
        projectSlug: run.scopeId,
      }).catch(() =>
        Message.error(
          t("kanban.openRoutineWorkItemError", {
            defaultValue: "Could not open the Work Item",
          })
        )
      );
    },
    [openResult, run.scopeId, t]
  );

  const toggle = useCallback(() => {
    setExpanded((previous) => !previous);
  }, []);

  useEffect(() => {
    if (!expanded || detail) return;
    let cancelled = false;
    projectApi
      .routineRunStatus(run.id)
      .then((status) => {
        if (!cancelled) setDetail(status);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setDetailError(
            error instanceof Error ? error.message : String(error)
          );
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, detail, run.id]);

  const Chevron = expanded ? ChevronDown : ChevronRight;
  const liveStatus = detail?.status ?? run.status;

  return (
    <div className="border-b border-border-1">
      <button
        type="button"
        onClick={toggle}
        data-testid={`routine-run-row-${run.id}`}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-fill-1"
      >
        <Chevron
          size={14}
          strokeWidth={1.75}
          className="shrink-0 text-text-3"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-text-1">
            {run.routineName}
            <span className="ml-1 text-[11px] text-text-3">
              rev {run.routineRevision}
            </span>
          </div>
          <div className="truncate text-[11px] text-text-3">
            {run.id} · {run.scopeId}
            {run.rootWorkItemId ? ` · ${run.rootWorkItemId}` : ""}
          </div>
        </div>
        <RunStatusLabel status={liveStatus} />
        <span className="shrink-0 text-[11px] text-text-3">
          {new Date(run.createdAt).toLocaleString()}
        </span>
      </button>
      {expanded && (
        <div className="px-11 pb-3">
          {detailError ? (
            <div className="text-[12px] text-danger-6">{detailError}</div>
          ) : !detail ? (
            <div className="text-[12px] text-text-3">…</div>
          ) : detail.workItems.length === 0 ? (
            <div className="text-[12px] text-text-3">—</div>
          ) : (
            <ul className="flex flex-col gap-1">
              {detail.workItems.map((item) => (
                <li key={item.shortId} className="text-[12px]">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-fill-1"
                    onClick={() => openWorkItem(item.shortId)}
                    data-testid={`routine-run-work-item-${item.shortId}`}
                  >
                    <span className="font-medium text-primary-6">
                      {item.shortId}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-text-2">
                      {item.title}
                    </span>
                    <span className="text-text-3">
                      {item.portableState ?? item.status}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

const RoutineRunsSurface: React.FC = () => {
  const { t } = useTranslation("sessions");
  const [runs, setRuns] = useState<RoutineRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    projectApi
      .listRoutineRuns({ limit: 200 })
      .then((rows) => {
        setRuns(rows);
        setError(null);
      })
      .catch((loadError: unknown) => {
        setError(
          loadError instanceof Error ? loadError.message : String(loadError)
        );
      });
  }, []);

  useEffect(() => {
    load();
    // Runs advance while the surface is hidden; refetch when the window
    // regains focus rather than polling.
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-testid="routine-runs-surface"
    >
      <div className="flex h-[40px] shrink-0 items-center justify-between border-b border-border-1 px-4">
        <div className="flex items-center gap-1.5 text-[13px] font-medium text-text-1">
          <PlayCircle size={14} strokeWidth={1.75} className="text-text-3" />
          {t("kanban.sidebar.runs", { defaultValue: "Runs" })}
        </div>
        <Button
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          icon={<RefreshCw size={13} strokeWidth={1.75} />}
          onClick={load}
          data-testid="routine-runs-refresh"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <Placeholder variant="error" title={error} fillParentHeight />
        ) : runs === null ? (
          <Placeholder variant="loading" fillParentHeight />
        ) : runs.length === 0 ? (
          <Placeholder
            variant="empty"
            title={t("kanban.runsEmpty", {
              defaultValue: "No routine runs yet",
            })}
            fillParentHeight
          />
        ) : (
          runs.map((run) => <RunRow key={run.id} run={run} />)
        )}
      </div>
    </div>
  );
};

export default RoutineRunsSurface;
