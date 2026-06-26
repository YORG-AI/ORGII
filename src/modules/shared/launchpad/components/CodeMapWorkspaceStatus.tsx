import { RefreshCw, Square, Trash2 } from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  CODE_MAP_INDEX_PHASE,
  CODE_MAP_STATUS,
  type CodeMapStatusKind,
  type CodeMapWorkspaceStatus,
  type CodeMapWorkspaceSummary,
} from "@src/api/tauri/codeMap";
import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import StatusDot from "@src/components/StatusDot";
import { useCodeMapWorkspaceStatus } from "@src/hooks/codeMap";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  CollapsibleSection,
  DETAIL_PANEL_TOKENS,
} from "@src/modules/shared/layouts/blocks";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

const CODE_MAP_STATUS_COLOR: Record<CodeMapStatusKind, string> = {
  [CODE_MAP_STATUS.NOT_INDEXED]: "bg-text-4",
  [CODE_MAP_STATUS.INDEXING]: "bg-primary-6",
  [CODE_MAP_STATUS.READY]: "bg-success-6",
  [CODE_MAP_STATUS.STALE]: "bg-warning-6",
  [CODE_MAP_STATUS.FAILED]: "bg-danger-6",
  [CODE_MAP_STATUS.CANCELLED]: "bg-text-4",
};

const CODE_MAP_STATUS_TEXT_COLOR: Record<CodeMapStatusKind, string> = {
  [CODE_MAP_STATUS.NOT_INDEXED]: "text-text-3",
  [CODE_MAP_STATUS.INDEXING]: "text-primary-6",
  [CODE_MAP_STATUS.READY]: "text-success-6",
  [CODE_MAP_STATUS.STALE]: "text-warning-6",
  [CODE_MAP_STATUS.FAILED]: "text-danger-6",
  [CODE_MAP_STATUS.CANCELLED]: "text-text-3",
};

const CODE_MAP_STATUS_LABEL_KEY: Record<CodeMapStatusKind, string> = {
  [CODE_MAP_STATUS.NOT_INDEXED]: "controlTower.codeMap.status.notIndexed",
  [CODE_MAP_STATUS.INDEXING]: "controlTower.codeMap.status.indexing",
  [CODE_MAP_STATUS.READY]: "controlTower.codeMap.status.ready",
  [CODE_MAP_STATUS.STALE]: "controlTower.codeMap.status.stale",
  [CODE_MAP_STATUS.FAILED]: "controlTower.codeMap.status.failed",
  [CODE_MAP_STATUS.CANCELLED]: "controlTower.codeMap.status.cancelled",
};

const CODE_MAP_PHASE_LABEL_KEY = {
  [CODE_MAP_INDEX_PHASE.QUEUED]: "controlTower.codeMap.phase.queued",
  [CODE_MAP_INDEX_PHASE.SCANNING]: "controlTower.codeMap.phase.scanning",
  [CODE_MAP_INDEX_PHASE.EXTRACTING]: "controlTower.codeMap.phase.extracting",
  [CODE_MAP_INDEX_PHASE.STORING]: "controlTower.codeMap.phase.storing",
  [CODE_MAP_INDEX_PHASE.RESOLVING]: "controlTower.codeMap.phase.resolving",
  [CODE_MAP_INDEX_PHASE.COMPLETE]: "controlTower.codeMap.phase.complete",
  [CODE_MAP_INDEX_PHASE.FAILED]: "controlTower.codeMap.phase.failed",
  [CODE_MAP_INDEX_PHASE.CANCELLED]: "controlTower.codeMap.phase.cancelled",
} as const;

interface CodeMapStatusDotProps {
  status?: CodeMapWorkspaceSummary | null;
  compact?: boolean;
}

interface CodeMapWorkspaceStatusPanelProps {
  workspacePath?: string | null;
}

function toTimestampMs(
  timestampSeconds: number | null | undefined
): number | null {
  return typeof timestampSeconds === "number" ? timestampSeconds * 1000 : null;
}

function progressPercent(status: CodeMapWorkspaceStatus | null): number | null {
  const progress = status?.progress;
  if (!progress || progress.filesTotal <= 0) return null;
  return Math.min(
    100,
    Math.round((progress.filesProcessed / progress.filesTotal) * 100)
  );
}

function formatIndexSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  if (unitIndex === 0) return `${bytes.toLocaleString()} ${units[unitIndex]}`;
  return `${value.toLocaleString(undefined, {
    maximumFractionDigits: 1,
    minimumFractionDigits: value < 10 ? 1 : 0,
  })} ${units[unitIndex]}`;
}

export const CodeMapStatusDot: React.FC<CodeMapStatusDotProps> = ({
  status,
  compact = false,
}) => {
  const { t } = useTranslation("sessions");
  const statusKind = status?.status ?? CODE_MAP_STATUS.NOT_INDEXED;
  const label = t(CODE_MAP_STATUS_LABEL_KEY[statusKind]);

  return (
    <StatusDot
      color={CODE_MAP_STATUS_COLOR[statusKind]}
      pulse={statusKind === CODE_MAP_STATUS.INDEXING}
      size="sm"
      label={compact ? undefined : label}
      labelClassName={`${CODE_MAP_STATUS_TEXT_COLOR[statusKind]} text-xs font-medium`}
      ariaLabel={t("controlTower.codeMap.statusAria", { status: label })}
    />
  );
};

export const CodeMapWorkspaceStatusPanel: React.FC<
  CodeMapWorkspaceStatusPanelProps
> = ({ workspacePath }) => {
  const { t } = useTranslation("sessions");
  const {
    status,
    loading,
    actionLoading,
    error,
    isIndexing,
    isStopping,
    refresh,
    startIndex,
    cancelIndex,
    clearIndex,
  } = useCodeMapWorkspaceStatus({
    workspacePath,
    enabled: Boolean(workspacePath),
  });

  const statusKind = status?.status ?? CODE_MAP_STATUS.NOT_INDEXED;
  const statusLabel = t(CODE_MAP_STATUS_LABEL_KEY[statusKind]);
  const lastIndexedAt = toTimestampMs(status?.lastIndexedAt);
  const percent = progressPercent(status);
  const phase = status?.progress?.phase;
  const phaseLabel = phase ? t(CODE_MAP_PHASE_LABEL_KEY[phase]) : null;
  const canClear =
    Boolean(status) && statusKind !== CODE_MAP_STATUS.NOT_INDEXED;
  const isReindexAction =
    statusKind === CODE_MAP_STATUS.READY ||
    statusKind === CODE_MAP_STATUS.STALE;
  const indexLabel = isReindexAction
    ? t("controlTower.codeMap.actions.reindex")
    : t("controlTower.codeMap.actions.index");

  const stats = useMemo(
    () => [
      {
        key: "files",
        label: t("controlTower.codeMap.stats.files"),
        value: status?.files ?? 0,
      },
      {
        key: "symbols",
        label: t("controlTower.codeMap.stats.symbols"),
        value: status?.symbols ?? 0,
      },
      {
        key: "relationships",
        label: t("controlTower.codeMap.stats.relationships"),
        value: status?.relationships ?? 0,
      },
      {
        key: "unresolved",
        label: t("controlTower.codeMap.stats.unresolved"),
        value: status?.unresolved ?? 0,
      },
      {
        key: "staleFiles",
        label: t("controlTower.codeMap.stats.staleFiles"),
        value: status?.staleFiles ?? 0,
      },
      {
        key: "indexSize",
        label: t("controlTower.codeMap.stats.indexSize"),
        value: formatIndexSize(status?.indexSizeBytes ?? 0),
      },
    ],
    [
      status?.files,
      status?.indexSizeBytes,
      status?.relationships,
      status?.staleFiles,
      status?.symbols,
      status?.unresolved,
      t,
    ]
  );

  const handleIndex = useCallback(() => {
    void startIndex(isReindexAction);
  }, [isReindexAction, startIndex]);

  const handleCancel = useCallback(() => {
    void cancelIndex();
  }, [cancelIndex]);

  const handleClear = useCallback(() => {
    void clearIndex();
  }, [clearIndex]);

  const handleRefresh = useCallback(() => {
    void refresh();
  }, [refresh]);

  const refreshLabel = t("controlTower.codeMap.actions.refresh");
  const clearLabel = t("controlTower.codeMap.actions.clear");
  const stopLabel = t("controlTower.codeMap.actions.stop");
  const { spinClass: refreshSpinClass, handleClick: handleRefreshClick } =
    useRefreshSpin(handleRefresh, loading, `code-map:${workspacePath}:refresh`);

  if (!workspacePath) return null;

  return (
    <CollapsibleSection title={t("controlTower.codeMap.title")} defaultOpen>
      <div className={DETAIL_PANEL_TOKENS.chatPanelInfoContainer}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[13px] font-semibold text-text-1">
                  {t("controlTower.codeMap.title")}
                </span>
                <CodeMapStatusDot status={status} />
              </div>
              <p className="mt-1 text-[12px] text-text-3">
                {lastIndexedAt
                  ? t("controlTower.codeMap.lastIndexed", {
                      time: formatRelativeTime(lastIndexedAt, "short"),
                    })
                  : t("controlTower.codeMap.neverIndexed")}
              </p>
            </div>
            <div className="flex max-w-full items-center gap-1.5 overflow-x-auto scrollbar-hide">
              {isIndexing ? (
                <Button
                  variant="warning"
                  size="small"
                  shape="round"
                  icon={<Square size={13} />}
                  loading={isStopping}
                  disabled={isStopping}
                  onClick={handleCancel}
                >
                  {stopLabel}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="small"
                  shape="round"
                  loading={actionLoading}
                  disabled={loading || actionLoading}
                  onClick={handleIndex}
                >
                  {indexLabel}
                </Button>
              )}
              <Button
                variant="secondary"
                size="small"
                shape="round"
                icon={<RefreshCw size={14} className={refreshSpinClass} />}
                iconOnly
                disabled={loading || actionLoading}
                onClick={handleRefreshClick}
                title={refreshLabel}
                aria-label={refreshLabel}
              />
              <Button
                variant="danger"
                appearance="outline"
                size="small"
                shape="round"
                icon={<Trash2 size={14} />}
                iconOnly
                disabled={!canClear || loading || actionLoading || isIndexing}
                onClick={handleClear}
                title={clearLabel}
                aria-label={clearLabel}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
            {stats.map((item) => (
              <div key={item.key} className="rounded-md bg-chat-pane px-3 py-2">
                <div className="text-[11px] text-text-3">{item.label}</div>
                <div className="mt-0.5 text-[14px] font-semibold tabular-nums text-text-1">
                  {typeof item.value === "number"
                    ? item.value.toLocaleString()
                    : item.value}
                </div>
              </div>
            ))}
          </div>

          {isIndexing ? (
            <div className="rounded-md bg-chat-pane p-3">
              <div className="flex items-center justify-between gap-3 text-[12px]">
                <span className="font-medium text-text-1">
                  {phaseLabel ?? statusLabel}
                </span>
                {percent !== null ? (
                  <span className="tabular-nums text-text-3">{percent}%</span>
                ) : null}
              </div>
              {percent !== null ? (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-fill-3">
                  <div
                    className="h-full rounded-full bg-primary-6 transition-[width]"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              ) : null}
              {status?.progress ? (
                <div className="mt-2 truncate text-[11px] text-text-3">
                  {t("controlTower.codeMap.progressFiles", {
                    processed: status.progress.filesProcessed,
                    total: status.progress.filesTotal,
                  })}
                  {status.progress.currentFile
                    ? ` · ${status.progress.currentFile}`
                    : ""}
                  <div className="mt-1">
                    {t("controlTower.codeMap.progressChanges", {
                      added: status.progress.addedFiles,
                      modified: status.progress.modifiedFiles,
                      deleted: status.progress.deletedFiles,
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {error || status?.error ? (
            <InlineAlert
              type="danger"
              title={t("controlTower.codeMap.errorTitle")}
            >
              {error ?? status?.error}
            </InlineAlert>
          ) : null}
        </div>
      </div>
    </CollapsibleSection>
  );
};
