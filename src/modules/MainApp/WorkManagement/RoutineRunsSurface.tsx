/**
 * RoutineRunsSurface
 *
 * The Runs navigation surface (orgtrack/v1 §7.2): rows from
 * `pm_routine_runs`, newest first, with the selected run's generated WorkItem
 * graph shown in the shared Work Management detail pane. Status comes from the
 * durable ordered projection (`project_routine_run_status`), not from a cached
 * copy.
 */
import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  type RoutineRunStatus,
  type RoutineRunSummary,
  projectApi,
} from "@src/api/http/project";
import { HeaderSectionSeparator } from "@src/components/HeaderSectionSeparator";
import Message from "@src/components/Message";
import { Placeholder } from "@src/components/Placeholder";
import TabPill from "@src/components/TabPill";
import { useRoutineResultNavigation } from "@src/hooks/navigation";
import { usePublishWorkstationTabHeader } from "@src/hooks/tabHost/useWorkstationTabHeader";
import { HugeiconsIcon, PlayCircleIcon } from "@src/icons";
import CompactListPanel, {
  type CompactListPanelEntry,
} from "@src/modules/shared/components/CompactListPanel";
import { WorkManagementRefreshButton } from "@src/modules/shared/components/WorkManagementRefreshButton";
import { WorkManagementSearchInput } from "@src/modules/shared/components/WorkManagementSearchInput";
import DetailPaneLayout, {
  DetailPanePlaceholder,
} from "@src/modules/shared/layouts/DetailPaneLayout";
import InboxListDetailLayout from "@src/modules/shared/layouts/InboxListDetailLayout";
import SplitListFullscreenButton from "@src/modules/shared/layouts/SplitListFullscreenButton";
import SplitListHeader from "@src/modules/shared/layouts/SplitListHeader";

import { useWorkManagementSplitHeader } from "./workManagementSplitHeaderContext";

const RoutineWebhooksPanel = React.lazy(() => import("./RoutineWebhooksPanel"));

const STATUS_TONE: Record<string, string> = {
  succeeded: "text-success-6",
  failed: "text-danger-6",
  running: "text-primary-6",
  pending: "text-text-3",
  cancelled: "text-text-3",
};

export function searchRoutineRuns(
  runs: readonly RoutineRunSummary[],
  query: string
): RoutineRunSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...runs];

  return runs.filter((run) =>
    [
      run.routineName,
      run.id,
      run.scopeId,
      run.rootWorkItemId,
      run.status,
      run.createdBy,
    ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery))
  );
}

const RunStatusLabel: React.FC<{ status: string }> = ({ status }) => (
  <span
    className={`text-[12px] font-medium ${STATUS_TONE[status] ?? "text-text-2"}`}
  >
    {status}
  </span>
);

interface RoutineRunsListProps {
  runs: readonly RoutineRunSummary[];
  selectedRunId: string | null;
  loading: boolean;
  emptyContent: React.ReactNode;
  onSelectRun: (run: RoutineRunSummary) => void;
}

const RoutineRunsList: React.FC<RoutineRunsListProps> = ({
  runs,
  selectedRunId,
  loading,
  emptyContent,
  onSelectRun,
}) => {
  const { t } = useTranslation("sessions");
  const entries = useMemo<CompactListPanelEntry[]>(
    () =>
      runs.map((run) => ({
        key: run.id,
        title: run.routineName,
        titlePrefix: `rev ${run.routineRevision}`,
        time: new Date(run.createdAt).toLocaleString(),
        metadata: (
          <span className="truncate">
            {run.id} · {run.scopeId}
          </span>
        ),
        leading: (
          <HugeiconsIcon
            icon={PlayCircleIcon}
            data-icon="play-circle"
            size={14}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        ),
        leadingClassName: STATUS_TONE[run.status] ?? "text-text-3",
        ariaLabel: `${run.routineName}, ${run.status}, ${run.scopeId}`,
        dataAttributes: {
          "data-testid": "routine-run-row",
          "data-run-id": run.id,
        },
        onSelect: () => onSelectRun(run),
      })),
    [onSelectRun, runs]
  );

  return (
    <CompactListPanel
      ariaLabel={t("kanban.sidebar.runs", { defaultValue: "Runs" })}
      entries={entries}
      selectedEntryKey={selectedRunId}
      loading={loading}
      emptyContent={emptyContent}
      testId="routine-runs-compact-list"
    />
  );
};

interface RoutineRunDetailPaneProps {
  run: RoutineRunSummary | null;
  onClose: () => void;
}

const RoutineRunDetailPane: React.FC<RoutineRunDetailPaneProps> = ({
  run,
  onClose,
}) => {
  const { t } = useTranslation(["sessions", "projects", "common"]);
  const [detail, setDetail] = useState<RoutineRunStatus | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const openResult = useRoutineResultNavigation();

  useEffect(() => {
    if (!run) return;
    let cancelled = false;
    projectApi
      .routineRunStatus(run.id)
      .then((status) => {
        if (!cancelled) setDetail(status);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDetailError(
            error instanceof Error ? error.message : String(error)
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [run]);

  const openWorkItem = useCallback(
    (workItemId: string) => {
      if (!run) return;
      void openResult({
        workItemId,
        projectSlug: run.scopeId,
      }).catch(() =>
        Message.error(
          t("sessions:kanban.openRoutineWorkItemError", {
            defaultValue: "Could not open the Work Item",
          })
        )
      );
    },
    [openResult, run, t]
  );

  if (!run) {
    return (
      <DetailPaneLayout testId="routine-run-detail-pane">
        <DetailPanePlaceholder
          variant="empty"
          title={t("common:teamInbox.empty.selectTitle")}
          subtitle={t("common:teamInbox.empty.selectSubtitle")}
        />
      </DetailPaneLayout>
    );
  }

  return (
    <DetailPaneLayout
      testId="routine-run-detail-pane"
      header={{
        title: run.routineName,
        subtitle: `rev ${run.routineRevision}`,
        icon: PlayCircleIcon,
        actions: <RunStatusLabel status={detail?.status ?? run.status} />,
      }}
      onClose={onClose}
      closeTestId="routine-run-detail-close"
    >
      {detailError ? (
        <DetailPanePlaceholder variant="error" subtitle={detailError} />
      ) : !detail ? (
        <DetailPanePlaceholder variant="loading" />
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
          data-testid={`routine-run-detail-${run.id}`}
        >
          <div className="rounded-lg bg-fill-1 px-3 py-2.5 text-[12px] text-text-2">
            <div className="font-medium text-text-1">{detail.id}</div>
            <div className="mt-1 text-text-3">
              {detail.scopeId}
              {detail.rootWorkItemId ? ` · ${detail.rootWorkItemId}` : ""}
            </div>
          </div>
          <section className="flex flex-col gap-2">
            <h3 className="text-[12px] font-medium text-text-1">
              {t("projects:workspace.workItems")}
            </h3>
            {detail.workItems.length === 0 ? (
              <Placeholder variant="empty" />
            ) : (
              <ul className="flex flex-col gap-1">
                {detail.workItems.map((item) => (
                  <li key={item.shortId}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-fill-1"
                      onClick={() => openWorkItem(item.shortId)}
                      data-testid={`routine-run-work-item-${item.shortId}`}
                    >
                      <span className="font-medium text-primary-6">
                        {item.shortId}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-text-2">
                        {item.title}
                      </span>
                      <span className="shrink-0 text-text-3">
                        {item.portableState ?? item.status}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </DetailPaneLayout>
  );
};

const RoutineRunsSurface: React.FC = () => {
  const { t } = useTranslation("sessions");
  const { splitDatasetControl, surfaceDatasetControl } =
    useWorkManagementSplitHeader();
  const [runs, setRuns] = useState<RoutineRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<"runs" | "webhooks">("runs");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [listFullscreen, setListFullscreen] = useState(false);

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
    if (activeView !== "runs") return;
    load();
    // Runs advance while the surface is hidden; refetch when the window
    // regains focus rather than polling.
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [activeView, load]);

  const publishedHeader = React.useMemo(() => ({ hidden: true }), []);
  usePublishWorkstationTabHeader({
    host: "workManagement",
    content: publishedHeader,
  });

  const runsLabel = t("kanban.sidebar.runs", { defaultValue: "Runs" });
  const refreshLabel = t("common:actions.refresh", {
    defaultValue: "Refresh",
  });
  const visibleRuns = useMemo(
    () => (runs ? searchRoutineRuns(runs, searchQuery) : []),
    [runs, searchQuery]
  );
  const selectedRun =
    visibleRuns.find((run) => run.id === selectedRunId) ?? null;

  const handleSelectRun = useCallback((run: RoutineRunSummary) => {
    setSelectedRunId(run.id);
    setListFullscreen(false);
  }, []);
  const handleToggleListPresentation = useCallback(() => {
    setListFullscreen((current) => !current);
  }, []);
  const handleCloseDetail = useCallback(() => setSelectedRunId(null), []);
  const handleSelectWebhookDetail = useCallback(
    () => setListFullscreen(false),
    []
  );

  const tabs = [
    { key: "runs", label: runsLabel },
    {
      key: "webhooks",
      label: t("webhooks.title", { defaultValue: "Webhooks" }),
    },
  ];
  const datasetTabs = (
    <TabPill
      tabs={tabs}
      activeTab={activeView}
      onChange={(key) => setActiveView(key as "runs" | "webhooks")}
      variant="pill"
      color="fill"
      fillWidth={false}
      size="small"
      height={28}
    />
  );
  const headerActions = (
    <div className="flex shrink-0 items-center gap-px">
      {activeView === "runs" ? (
        <WorkManagementRefreshButton
          label={refreshLabel}
          loading={false}
          onRefresh={load}
          dataTestId="routine-runs-refresh"
        />
      ) : null}
      <SplitListFullscreenButton
        isFullscreen={listFullscreen}
        onToggle={handleToggleListPresentation}
      />
    </div>
  );
  const splitListHeader = !listFullscreen ? (
    <SplitListHeader
      primary={
        <div className="flex min-w-0 flex-1 items-center gap-px">
          {splitDatasetControl}
          {splitDatasetControl ? (
            <HeaderSectionSeparator className="mx-0.5" />
          ) : null}
          {datasetTabs}
        </div>
      }
      secondary={
        <div className="flex min-w-0 flex-1 items-center gap-px">
          <WorkManagementSearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placement="header"
            fillWidth
            dataTestId="routine-search"
          />
          {headerActions}
        </div>
      }
    />
  ) : null;
  const fullListHeader = listFullscreen ? (
    <SplitListHeader
      fullWidth
      primary={
        <div className="flex min-w-0 flex-1 items-center gap-px">
          {surfaceDatasetControl}
          {surfaceDatasetControl ? (
            <HeaderSectionSeparator className="mx-0.5" />
          ) : null}
          {datasetTabs}
          <div className="ml-auto flex min-w-0 items-center gap-px">
            <WorkManagementSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placement="header"
              dataTestId="routine-search"
            />
            {headerActions}
          </div>
        </div>
      }
    />
  ) : null;

  const runsEmptyContent = error ? (
    <Placeholder
      variant="error"
      placement="sidebar"
      title={error}
      fillParentHeight
    />
  ) : runs && runs.length === 0 ? (
    <Placeholder
      variant="empty"
      placement="sidebar"
      title={t("kanban.runsEmpty", { defaultValue: "No routine runs yet" })}
      fillParentHeight
    />
  ) : (
    <Placeholder variant="no-results" placement="sidebar" fillParentHeight />
  );
  const runsList = (
    <RoutineRunsList
      runs={visibleRuns}
      selectedRunId={selectedRun?.id ?? null}
      loading={runs === null && !error}
      emptyContent={runsEmptyContent}
      onSelectRun={handleSelectRun}
    />
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-testid="routine-runs-surface"
    >
      {activeView === "webhooks" ? (
        <Suspense fallback={<Placeholder variant="loading" fillParentHeight />}>
          <RoutineWebhooksPanel
            query={searchQuery}
            listHeader={splitListHeader}
            fullHeader={fullListHeader}
            listFullscreen={listFullscreen}
            onSelectDetail={handleSelectWebhookDetail}
          />
        </Suspense>
      ) : (
        <InboxListDetailLayout
          testId="routine-runs-list-detail-layout"
          defaultSplit
          listFullscreen={listFullscreen}
          listHeader={splitListHeader}
          fullHeader={fullListHeader}
          listContent={runsList}
          fullContent={runsList}
          detailContent={
            <RoutineRunDetailPane
              key={selectedRun?.id ?? "empty"}
              run={selectedRun}
              onClose={handleCloseDetail}
            />
          }
        />
      )}
    </div>
  );
};

export default RoutineRunsSurface;
