import { Repeat } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { type WorkItemRun, projectApi } from "@src/api/http/project";
import { useProjectDataChanged } from "@src/hooks/project";
import {
  formatTokensShort,
  formatUsd,
} from "@src/modules/shared/dataSource/usageFormat";
import {
  ScrollTrailTarget,
  SessionTable,
  type SessionTableItem,
} from "@src/modules/shared/layouts/blocks";
import {
  formatReplayDateLabel,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";

interface WorkItemRunUsageSummaryProps {
  projectSlug?: string | null;
  orgId?: string | null;
  shortId?: string | null;
  navigationEnabled?: boolean;
  onOpenSession?: (sessionId: string) => void;
}

const RUN_STATUS_COLOR: Record<WorkItemRun["status"], string> = {
  queued: "var(--color-fill-4)",
  deferred: "var(--color-warning-6)",
  dispatching: "var(--color-primary-5)",
  running: "var(--color-primary-6)",
  waiting: "var(--color-warning-6)",
  succeeded: "var(--color-success-6)",
  failed: "var(--color-danger-6)",
  cancelled: "var(--color-warning-6)",
};

export function summarizeWorkItemRuns(runs: WorkItemRun[]) {
  return runs.reduce(
    (total, run) => ({
      inputTokens: total.inputTokens + run.usage.inputTokens,
      outputTokens: total.outputTokens + run.usage.outputTokens,
      cacheReadTokens: total.cacheReadTokens + run.usage.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + run.usage.cacheWriteTokens,
      totalTokens: total.totalTokens + run.usage.totalTokens,
      costUsd: total.costUsd + run.usage.costUsd,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    }
  );
}

const triggerLabel = (run: WorkItemRun) =>
  run.trigger.kind
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const WorkItemRunUsageSummary: React.FC<WorkItemRunUsageSummaryProps> = ({
  projectSlug,
  orgId,
  shortId,
  navigationEnabled = false,
  onOpenSession,
}) => {
  const { t, i18n } = useTranslation(["projects", "common"]);
  const queryKey = `${orgId ?? "personal-org"}:${projectSlug ?? "-"}:${shortId ?? "-"}`;
  const [runState, setRunState] = useState<{
    key: string;
    runs: WorkItemRun[];
  }>({ key: "", runs: [] });
  const [refreshKey, setRefreshKey] = useState(0);
  useProjectDataChanged(() => setRefreshKey((value) => value + 1));

  useEffect(() => {
    if (!shortId) return;
    let cancelled = false;
    projectApi
      .listWorkItemRuns({ projectSlug, orgId, shortId })
      .then((runs) => {
        if (!cancelled) setRunState({ key: queryKey, runs });
      })
      .catch(() => {
        if (!cancelled) setRunState({ key: queryKey, runs: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, projectSlug, queryKey, refreshKey, shortId]);

  const runs = useMemo(
    () => (runState.key === queryKey ? runState.runs : []),
    [queryKey, runState]
  );
  const usage = useMemo(() => summarizeWorkItemRuns(runs), [runs]);
  const dateOptions = useMemo(
    () => ({
      todayLabel: t("common:relativeDate.today"),
      yesterdayLabel: t("common:relativeDate.yesterday"),
      locale: toIntlLocaleTag(i18n.resolvedLanguage),
    }),
    [i18n.resolvedLanguage, t]
  );
  const tableItems = useMemo<SessionTableItem[]>(
    () =>
      runs.map((run) => ({
        id: run.id,
        title: triggerLabel(run),
        description: run.sessionId ?? run.id,
        statusLabel: run.status,
        statusColor: RUN_STATUS_COLOR[run.status],
        agentIcon: <Repeat size={14} strokeWidth={1.75} />,
        agentLabel: "Run",
        modelLabel: run.trigger.kind,
        tokensLabel:
          run.usage.totalTokens > 0
            ? formatTokensShort(run.usage.totalTokens)
            : undefined,
        tokensValue:
          run.usage.totalTokens > 0 ? run.usage.totalTokens : undefined,
        startedLabel: formatReplayDateLabel(run.startedAt ?? run.createdAt, {
          ...dateOptions,
          withSeconds: false,
          monthStyle: "short",
        }),
        lastUpdatedLabel: formatReplayDateLabel(
          run.completedAt ?? run.updatedAt,
          {
            ...dateOptions,
            withSeconds: false,
            monthStyle: "short",
          }
        ),
        disabled: !run.sessionId || !onOpenSession,
        testId: `work-item-run-${run.id}`,
      })),
    [dateOptions, onOpenSession, runs]
  );

  if (runs.length === 0) return null;

  return (
    <ScrollTrailTarget
      enabled={navigationEnabled}
      label={t("workItems.outputTab.costSummary")}
    >
      <section data-testid="work-item-run-usage-summary">
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-text-4">
          <span>
            {runs.length} {runs.length === 1 ? "run" : "runs"}
          </span>
          <span>{formatTokensShort(usage.totalTokens)} tokens</span>
          <span>{usage.inputTokens.toLocaleString()} in</span>
          <span>{usage.outputTokens.toLocaleString()} out</span>
          {usage.cacheReadTokens > 0 ? (
            <span>{usage.cacheReadTokens.toLocaleString()} cache read</span>
          ) : null}
          {usage.cacheWriteTokens > 0 ? (
            <span>{usage.cacheWriteTokens.toLocaleString()} cache write</span>
          ) : null}
          {usage.costUsd > 0 ? (
            <span>{formatUsd(usage.costUsd, 4)}</span>
          ) : null}
        </div>
        <SessionTable
          items={tableItems}
          onSelect={(item) => {
            const sessionId = runs.find((run) => run.id === item.id)?.sessionId;
            if (sessionId) onOpenSession?.(sessionId);
          }}
          showSearch={false}
          maxHeight={320}
          columnVisibility={{
            agent: false,
            model: true,
            workspace: false,
            impact: false,
            filesChanged: false,
            relatedCommits: false,
            committedRate: false,
            tokens: true,
            started: true,
            lastUpdated: true,
          }}
        />
      </section>
    </ScrollTrailTarget>
  );
};

export default WorkItemRunUsageSummary;
