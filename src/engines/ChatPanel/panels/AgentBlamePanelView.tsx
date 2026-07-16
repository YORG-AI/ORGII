import {
  Bot,
  FileText,
  GitCommit,
  Loader2,
  RefreshCw,
  Square,
  Users,
} from "lucide-react";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type OrgtrackFileSessionLookup,
  type OrgtrackIndex,
  type OrgtrackScanProgress,
  type OrgtrackTier,
  cancelOrgtrackScan,
  getOrgtrackIndex,
  getOrgtrackScanStatus,
  lookupOrgtrackFileSessions,
  startOrgtrackScan,
} from "@src/api/tauri/lineage";
import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import { useVisiblePolling } from "@src/hooks/async";
import {
  CollapsibleSection,
  DETAIL_PANEL_TOKENS,
} from "@src/modules/shared/layouts/blocks";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

interface AgentBlamePanelViewProps {
  repoPath: string;
}

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
}

const SCAN_POLL_INTERVAL_MS = 750;
const INDEX_REFRESH_INTERVAL_MS = 3_000;

const StatCard: React.FC<StatCardProps> = ({ icon, label, value }) => (
  <div className="rounded-md bg-chat-pane px-3 py-2">
    <div className="flex items-center gap-1.5 text-[11px] text-text-3">
      {icon}
      <span>{label}</span>
    </div>
    <div className="mt-0.5 text-[14px] font-semibold tabular-nums text-text-1">
      {typeof value === "number" ? value.toLocaleString() : value}
    </div>
  </div>
);

function formatGeneratedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return formatRelativeTime(timestamp, "short");
}

function scanPercent(scanProgress: OrgtrackScanProgress | null): number {
  if (!scanProgress || scanProgress.total <= 0) return 0;
  return Math.min(
    100,
    Math.round((scanProgress.processed / scanProgress.total) * 100)
  );
}

const AgentBlamePanelView: React.FC<AgentBlamePanelViewProps> = memo(
  ({ repoPath }) => {
    const { t } = useTranslation("common");
    const [index, setIndex] = useState<OrgtrackIndex | null>(null);
    const [scanProgress, setScanProgress] =
      useState<OrgtrackScanProgress | null>(null);
    const [selectedTier, setSelectedTier] = useState<OrgtrackTier>("meta");
    const [fileQuery, setFileQuery] = useState("");
    const [fileLookup, setFileLookup] =
      useState<OrgtrackFileSessionLookup | null>(null);
    const [fileLookupLoading, setFileLookupLoading] = useState(false);
    const [loading, setLoading] = useState(false);
    const [scanActionPending, setScanActionPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const loadIndex = useCallback(
      async (cancelledRef?: { current: boolean }) => {
        if (!repoPath) {
          setIndex(null);
          return;
        }

        setLoading(true);
        setError(null);
        try {
          const nextIndex = await getOrgtrackIndex(repoPath);
          if (!cancelledRef?.current) {
            setIndex(nextIndex);
          }
        } catch (err) {
          if (!cancelledRef?.current) {
            setError(err instanceof Error ? err.message : String(err));
            setIndex(null);
          }
        } finally {
          if (!cancelledRef?.current) {
            setLoading(false);
          }
        }
      },
      [repoPath]
    );

    const loadScanStatus = useCallback(
      async (cancelledRef?: { current: boolean }) => {
        if (!repoPath) {
          setScanProgress(null);
          return;
        }
        const nextStatus = await getOrgtrackScanStatus(repoPath);
        if (!cancelledRef?.current) {
          setScanProgress(nextStatus);
          if (nextStatus?.tier) {
            setSelectedTier(nextStatus.tier);
          }
        }
      },
      [repoPath]
    );

    useEffect(() => {
      const cancelledRef = { current: false };
      void loadIndex(cancelledRef);
      void loadScanStatus(cancelledRef);
      return () => {
        cancelledRef.current = true;
      };
    }, [loadIndex, loadScanStatus]);

    const lastIndexRefreshAtRef = React.useRef(0);
    const pollScanProgress = useCallback(async () => {
      await loadScanStatus();
      const now = Date.now();
      if (now - lastIndexRefreshAtRef.current >= INDEX_REFRESH_INTERVAL_MS) {
        lastIndexRefreshAtRef.current = now;
        await loadIndex();
      }
      return true;
    }, [loadIndex, loadScanStatus]);

    useVisiblePolling({
      enabled: scanProgress?.status === "running",
      intervalMs: SCAN_POLL_INTERVAL_MS,
      poll: pollScanProgress,
      immediate: false,
    });

    useEffect(() => {
      if (scanProgress?.status === "completed") {
        void loadIndex();
      }
    }, [loadIndex, scanProgress?.status]);

    const handleStartScan = useCallback(
      async (options?: { resume?: boolean; rebuild?: boolean }) => {
        if (!repoPath || scanActionPending) return;
        const allowRawTrajectory = selectedTier === "trajectory";
        if (
          allowRawTrajectory &&
          !window.confirm(t("labels.orgtrackTrajectoryConfirm"))
        ) {
          return;
        }

        setScanActionPending(true);
        setError(null);
        try {
          const nextProgress = await startOrgtrackScan({
            repoPath,
            tier: selectedTier,
            allowRawTrajectory,
            resume: options?.resume ?? true,
            rebuild: options?.rebuild ?? false,
          });
          setScanProgress(nextProgress);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setScanActionPending(false);
        }
      },
      [repoPath, scanActionPending, selectedTier, t]
    );

    const handleCancelScan = useCallback(async () => {
      if (!repoPath || scanActionPending) return;
      setScanActionPending(true);
      setError(null);
      try {
        const nextProgress = await cancelOrgtrackScan(repoPath);
        setScanProgress(nextProgress);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setScanActionPending(false);
      }
    }, [repoPath, scanActionPending]);

    const handleFileLookup = useCallback(async () => {
      const trimmedQuery = fileQuery.trim();
      if (!repoPath || !trimmedQuery) {
        setFileLookup(null);
        return;
      }

      setFileLookupLoading(true);
      setError(null);
      try {
        setFileLookup(
          await lookupOrgtrackFileSessions({
            repoPath,
            filePath: trimmedQuery,
          })
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setFileLookup(null);
      } finally {
        setFileLookupLoading(false);
      }
    }, [fileQuery, repoPath]);

    const stats = useMemo(() => {
      const sessions =
        scanProgress?.counts.sessions ?? index?.sessions.length ?? 0;
      const files = scanProgress?.counts.files ?? index?.files.length ?? 0;
      const commits =
        scanProgress?.counts.commits ?? index?.commits.length ?? 0;
      const entries =
        scanProgress?.counts.entries ??
        index?.files.reduce((sum, file) => sum + file.entriesCount, 0) ??
        0;
      const records = scanProgress?.counts.records ?? 0;

      return { sessions, files, commits, entries, records };
    }, [index, scanProgress]);

    const topSessions = useMemo(
      () =>
        [...(index?.sessions ?? [])]
          .sort((left, right) => right.filesCount - left.filesCount)
          .slice(0, 6),
      [index?.sessions]
    );

    const topFiles = useMemo(
      () =>
        [...(index?.files ?? [])]
          .sort((left, right) => right.entriesCount - left.entriesCount)
          .slice(0, 8),
      [index?.files]
    );

    const percent = scanPercent(scanProgress);
    const isRunning = scanProgress?.status === "running";
    const canResume =
      scanProgress?.resumable &&
      (scanProgress.status === "failed" || scanProgress.status === "cancelled");

    return (
      <div className="flex flex-col">
        <CollapsibleSection title={t("labels.agentBlame")} defaultOpen>
          <div className={DETAIL_PANEL_TOKENS.chatPanelInfoContainer}>
            <div className="flex flex-col gap-3">
              {error ? (
                <InlineAlert
                  type="danger"
                  title={t("labels.failedToLoadAgentBlame")}
                >
                  {error}
                </InlineAlert>
              ) : null}

              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[13px] font-semibold text-text-1">
                      {t("labels.agentBlame")}
                    </span>
                    <span className="rounded bg-chat-pane px-1.5 py-0.5 text-[11px] text-text-3">
                      {scanProgress?.status ?? t("labels.orgtrackScanIdle")}
                    </span>
                    {index ? (
                      <span className="rounded bg-chat-pane px-1.5 py-0.5 text-[11px] text-text-3">
                        {index.exportedTier}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-[12px] text-text-3">
                    {index
                      ? `${t("labels.generated")} ${formatGeneratedAt(
                          index.generatedAt
                        )}`
                      : t("labels.initializeOrgtrackMetadataHint")}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="h-7 rounded border border-border-2 bg-chat-pane px-2 text-[12px] text-text-1"
                    value={selectedTier}
                    disabled={isRunning || scanActionPending}
                    onChange={(event) =>
                      setSelectedTier(event.target.value as OrgtrackTier)
                    }
                  >
                    <option value="meta">{t("labels.metadataOnly")}</option>
                    <option value="details">
                      {t("labels.orgtrackDetailsTier")}
                    </option>
                    <option value="trajectory">
                      {t("labels.orgtrackTrajectoryTier")}
                    </option>
                  </select>
                  {isRunning ? (
                    <Button
                      variant="secondary"
                      appearance="outline"
                      size="small"
                      icon={<Square size={12} />}
                      loading={scanActionPending}
                      onClick={handleCancelScan}
                    >
                      {t("actions.cancel")}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      size="small"
                      icon={<RefreshCw size={13} />}
                      loading={scanActionPending}
                      loadingSpinIcon
                      onClick={() => void handleStartScan()}
                    >
                      {index
                        ? t("labels.rescan")
                        : t("labels.initializeAgentBlame")}
                    </Button>
                  )}
                  {canResume ? (
                    <Button
                      variant="secondary"
                      appearance="outline"
                      size="small"
                      onClick={() => void handleStartScan({ resume: true })}
                    >
                      {t("labels.orgtrackResumeScan")}
                    </Button>
                  ) : null}
                  {!isRunning && index ? (
                    <Button
                      variant="secondary"
                      appearance="outline"
                      size="small"
                      onClick={() =>
                        void handleStartScan({ resume: false, rebuild: true })
                      }
                    >
                      {t("labels.orgtrackRebuildIndex")}
                    </Button>
                  ) : null}
                </div>
              </div>

              {scanProgress ? (
                <div className="rounded-md bg-chat-pane px-3 py-2">
                  <div className="flex items-center justify-between gap-2 text-[11px] text-text-3">
                    <span>
                      {t("labels.orgtrackScanPhase")}: {scanProgress.phase}
                    </span>
                    <span>{percent}%</span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border-2">
                    <div
                      className="h-full rounded-full bg-text-1 transition-all"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  {scanProgress.lastError ? (
                    <div className="text-danger mt-2 text-[11px]">
                      {scanProgress.lastError}
                    </div>
                  ) : null}
                </div>
              ) : loading ? (
                <div className="flex items-center gap-2 text-[12px] text-text-3">
                  <Loader2 size={14} className="animate-spin" />
                  <span>{t("labels.loadingAgentBlame")}</span>
                </div>
              ) : null}

              <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
                <StatCard
                  icon={<Users size={12} />}
                  label={t("labels.sessions")}
                  value={stats.sessions}
                />
                <StatCard
                  icon={<FileText size={12} />}
                  label={t("labels.files")}
                  value={stats.files}
                />
                <StatCard
                  icon={<GitCommit size={12} />}
                  label={t("labels.commits")}
                  value={stats.commits}
                />
                <StatCard
                  icon={<Bot size={12} />}
                  label={t("labels.entries")}
                  value={stats.entries}
                />
                <StatCard
                  icon={<FileText size={12} />}
                  label={t("labels.records")}
                  value={stats.records}
                />
              </div>

              {index?.summary ? (
                <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                  <div className="rounded-md bg-chat-pane px-3 py-2">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-text-3">
                      {t("labels.sessionsByAppType")}
                    </div>
                    <div className="mt-2 flex flex-col gap-1">
                      {index.summary.sessionsByAppType.map((bucket) => (
                        <div
                          key={bucket.key}
                          className="flex items-center justify-between gap-2 text-[12px]"
                        >
                          <span className="truncate text-text-2">
                            {bucket.label}
                          </span>
                          <span className="tabular-nums text-text-3">
                            {bucket.count.toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-md bg-chat-pane px-3 py-2">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-text-3">
                      {t("labels.modelsUsed")}
                    </div>
                    <div className="mt-2 flex flex-col gap-1">
                      {index.summary.modelsUsed.map((bucket) => (
                        <div
                          key={bucket.key}
                          className="flex items-center justify-between gap-2 text-[12px]"
                        >
                          <span className="truncate text-text-2">
                            {bucket.label}
                          </span>
                          <span className="tabular-nums text-text-3">
                            {bucket.count.toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="rounded-md bg-chat-pane px-3 py-2">
                <div className="text-[11px] font-medium uppercase tracking-wide text-text-3">
                  {t("labels.lookupFileSessions")}
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    className="min-w-0 flex-1 rounded border border-border-2 bg-bg-1 px-2 py-1 text-[12px] text-text-1"
                    value={fileQuery}
                    placeholder={t("labels.typeFilePath")}
                    onChange={(event) => setFileQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void handleFileLookup();
                      }
                    }}
                  />
                  <Button
                    variant="secondary"
                    appearance="outline"
                    size="small"
                    loading={fileLookupLoading}
                    loadingSpinIcon
                    onClick={() => void handleFileLookup()}
                  >
                    {t("actions.search")}
                  </Button>
                </div>
                {fileLookup ? (
                  <div className="mt-2 flex flex-col gap-1">
                    {fileLookup.sessions.length > 0 ? (
                      fileLookup.sessions.map((session) => (
                        <div
                          key={session.sessionId}
                          className="rounded border border-border-2 px-2 py-1.5"
                        >
                          <div className="truncate text-[12px] font-medium text-text-1">
                            {session.sessionLabel ?? session.sessionId}
                          </div>
                          <div className="mt-0.5 truncate text-[11px] text-text-3">
                            {formatRelativeTime(
                              session.lastEditAt * 1000,
                              "compact"
                            )}{" "}
                            · {session.editCount.toLocaleString()}{" "}
                            {t("labels.entries")} ·{" "}
                            {session.commitShas.length.toLocaleString()}{" "}
                            {t("labels.commits")}
                          </div>
                          {session.commitShas.length > 0 ? (
                            <div className="mt-0.5 truncate text-[11px] text-text-3">
                              {t("labels.appliedCommits")}:{" "}
                              {session.commitShas.join(", ")}
                            </div>
                          ) : (
                            <div className="mt-0.5 text-[11px] text-warning-6">
                              {t("labels.noAppliedCommit")}
                            </div>
                          )}
                        </div>
                      ))
                    ) : (
                      <div className="text-[12px] text-text-3">
                        {t("labels.noSessionsForFile")}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection title={t("labels.topSessions")} defaultOpen={false}>
          <div className={DETAIL_PANEL_TOKENS.chatPanelInfoContainer}>
            {topSessions.length > 0 ? (
              <div className="flex flex-col gap-2">
                {topSessions.map((session) => (
                  <div
                    key={session.sessionId}
                    className="rounded-md bg-chat-pane px-3 py-2"
                  >
                    <div className="truncate text-[13px] font-medium text-text-1">
                      {session.label || session.sessionId}
                    </div>
                    <div className="mt-0.5 text-[11px] text-text-3">
                      {session.filesCount.toLocaleString()} {t("labels.files")}{" "}
                      · {session.commitsCount.toLocaleString()}{" "}
                      {t("labels.commits")}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[12px] text-text-3">
                {t("labels.noSessions")}
              </div>
            )}
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title={t("labels.mostAttributedFiles")}
          defaultOpen={false}
        >
          <div className={DETAIL_PANEL_TOKENS.chatPanelInfoContainer}>
            {topFiles.length > 0 ? (
              <div className="flex flex-col gap-2">
                {topFiles.map((file) => (
                  <div
                    key={file.pathHash}
                    className="rounded-md bg-chat-pane px-3 py-2"
                  >
                    <div className="truncate text-[13px] font-medium text-text-1">
                      {file.path}
                    </div>
                    <div className="mt-0.5 text-[11px] text-text-3">
                      {file.sessionsCount.toLocaleString()}{" "}
                      {t("labels.sessions")} ·{" "}
                      {file.commitsCount.toLocaleString()} {t("labels.commits")}{" "}
                      · {file.entriesCount.toLocaleString()}{" "}
                      {t("labels.entries")}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[12px] text-text-3">
                {t("labels.noFiles")}
              </div>
            )}
          </div>
        </CollapsibleSection>
      </div>
    );
  }
);

AgentBlamePanelView.displayName = "AgentBlamePanelView";

export default AgentBlamePanelView;
