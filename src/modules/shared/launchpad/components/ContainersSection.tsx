import { Eye, Play, RefreshCw, RotateCcw, Square } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  CONTAINER_STATE,
  type ContainerInspect,
  type ContainerSummary,
  containerApi,
} from "@src/api/tauri/container";
import Button from "@src/components/Button";
import Message from "@src/components/Message";
import { Placeholder } from "@src/components/Placeholder";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  CollapsibleSection,
  DETAIL_PANEL_TOKENS,
} from "@src/modules/shared/layouts/blocks";

interface ContainersSectionProps {
  title: string;
  containers: ContainerSummary[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  emptyTitle: string;
  emptySubtitle?: string;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  compact?: boolean;
}

const STATE_DOT_CLASS: Record<string, string> = {
  [CONTAINER_STATE.CREATED]: "bg-warning-6",
  [CONTAINER_STATE.RUNNING]: "bg-success-6",
  [CONTAINER_STATE.PAUSED]: "bg-warning-6",
  [CONTAINER_STATE.RESTARTING]: "bg-primary-6",
  [CONTAINER_STATE.EXITED]: "bg-text-4",
  [CONTAINER_STATE.REMOVING]: "bg-danger-6",
  [CONTAINER_STATE.DEAD]: "bg-danger-6",
  [CONTAINER_STATE.STOPPING]: "bg-warning-6",
  [CONTAINER_STATE.UNKNOWN]: "bg-text-4",
};

function formatPorts(container: ContainerSummary): string {
  if (container.ports.length === 0) return "—";
  return container.ports
    .map((port) => {
      const protocol = port.protocol ? `/${port.protocol}` : "";
      if (port.public_port) {
        return `${port.public_port}:${port.private_port}${protocol}`;
      }
      return `${port.private_port}${protocol}`;
    })
    .join(", ");
}

function formatCompose(container: ContainerSummary): string {
  const parts = [container.compose.project, container.compose.service].filter(
    Boolean
  );
  return parts.length > 0 ? parts.join(" / ") : "—";
}

const ContainersSection: React.FC<ContainersSectionProps> = ({
  title,
  containers,
  loading,
  error,
  onRefresh,
  emptyTitle,
  emptySubtitle,
  onOpenChange,
  defaultOpen = false,
  compact = false,
}) => {
  const { t } = useTranslation(["navigation", "common"]);
  const [selectedInspect, setSelectedInspect] =
    useState<ContainerInspect | null>(null);
  const [actionContainerId, setActionContainerId] = useState<string | null>(
    null
  );
  const { spinClass, handleClick: handleRefreshClick } = useRefreshSpin(
    onRefresh,
    loading
  );

  const runAction = useCallback(
    async (
      container: ContainerSummary,
      action: "start" | "stop" | "restart"
    ) => {
      setActionContainerId(container.id);
      try {
        if (action === "start") {
          await containerApi.startContainer(container.id);
        } else if (action === "stop") {
          await containerApi.stopContainer(container.id);
        } else {
          await containerApi.restartContainer(container.id);
        }
        Message.success(
          t(`navigation:launchpad.containers.${action}Success`, {
            name: container.display_name,
          })
        );
        onRefresh();
      } catch (actionError: unknown) {
        Message.error(
          actionError instanceof Error
            ? actionError.message
            : String(actionError)
        );
      } finally {
        setActionContainerId(null);
      }
    },
    [onRefresh, t]
  );

  const handleInspect = useCallback(async (container: ContainerSummary) => {
    setActionContainerId(container.id);
    try {
      const inspect = await containerApi.inspectContainer(container.id);
      setSelectedInspect(inspect);
    } catch (inspectError: unknown) {
      Message.error(
        inspectError instanceof Error
          ? inspectError.message
          : String(inspectError)
      );
    } finally {
      setActionContainerId(null);
    }
  }, []);

  const columns = useMemo<SettingsTableColumn<ContainerSummary>[]>(
    () => [
      {
        key: "name",
        label: t("navigation:launchpad.containers.name"),
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (row) => (
          <div className="min-w-0">
            <div className="truncate text-text-1">{row.display_name}</div>
            <div className={SETTINGS_TABLE_CELL.subtitle}>{row.short_id}</div>
          </div>
        ),
      },
      {
        key: "image",
        label: t("navigation:launchpad.containers.image"),
        width: SETTINGS_TABLE_COL.valueLg,
        hideBelow: "sm",
        renderCell: (row) => (
          <span className={`${SETTINGS_TABLE_CELL.muted} block truncate`}>
            {row.image ?? "—"}
          </span>
        ),
      },
      {
        key: "state",
        label: t("navigation:launchpad.containers.state"),
        width: SETTINGS_TABLE_COL.valueSm,
        renderCell: (row) => (
          <span className={SETTINGS_TABLE_CELL.statusRow}>
            <span
              className={`h-2 w-2 rounded-full ${STATE_DOT_CLASS[row.state] ?? STATE_DOT_CLASS[CONTAINER_STATE.UNKNOWN]}`}
            />
            <span className={SETTINGS_TABLE_CELL.value}>
              {t(`navigation:launchpad.containers.states.${row.state}`)}
            </span>
          </span>
        ),
      },
      {
        key: "ports",
        label: t("navigation:launchpad.containers.ports"),
        width: SETTINGS_TABLE_COL.valueLg,
        hideBelow: "md",
        renderCell: (row) => (
          <span className={`${SETTINGS_TABLE_CELL.muted} whitespace-nowrap`}>
            {formatPorts(row)}
          </span>
        ),
      },
      {
        key: "compose",
        label: t("navigation:launchpad.containers.compose"),
        width: SETTINGS_TABLE_COL.valueLg,
        hideBelow: "md",
        renderCell: (row) => (
          <span className={`${SETTINGS_TABLE_CELL.muted} block truncate`}>
            {formatCompose(row)}
          </span>
        ),
      },
      {
        key: "actions",
        label: "",
        width: SETTINGS_TABLE_COL.hug,
        align: "right",
        renderCell: (row) => {
          const isRunning = row.state === CONTAINER_STATE.RUNNING;
          const actionLoading = actionContainerId === row.id;
          return (
            <div className="flex items-center justify-end gap-1">
              <Button
                variant="tertiary"
                size="mini"
                icon={<Eye size={13} />}
                loading={actionLoading}
                onClick={() => handleInspect(row)}
                aria-label={t("navigation:launchpad.containers.inspect")}
              />
              {isRunning ? (
                <Button
                  variant="tertiary"
                  size="mini"
                  icon={<Square size={13} />}
                  loading={actionLoading}
                  onClick={() => runAction(row, "stop")}
                  aria-label={t("navigation:launchpad.containers.stop")}
                />
              ) : (
                <Button
                  variant="tertiary"
                  size="mini"
                  icon={<Play size={13} />}
                  loading={actionLoading}
                  onClick={() => runAction(row, "start")}
                  aria-label={t("navigation:launchpad.containers.start")}
                />
              )}
              <Button
                variant="tertiary"
                size="mini"
                icon={<RotateCcw size={13} />}
                loading={actionLoading}
                onClick={() => runAction(row, "restart")}
                aria-label={t("navigation:launchpad.containers.restart")}
              />
            </div>
          );
        },
      },
    ],
    [actionContainerId, handleInspect, runAction, t]
  );

  return (
    <CollapsibleSection
      title={containers.length > 0 ? `${title} (${containers.length})` : title}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      compact={compact}
      actions={
        <Button
          variant="tertiary"
          size="mini"
          icon={<RefreshCw size={13} className={spinClass} />}
          onClick={handleRefreshClick}
          aria-label={t("common:actions.refresh")}
        />
      }
    >
      {error ? (
        <div className={DETAIL_PANEL_TOKENS.primaryContainer}>
          <Placeholder
            variant="error"
            title={t("navigation:launchpad.containers.dockerUnavailable")}
            subtitle={error}
            action={{
              label: t("common:actions.refresh"),
              onClick: onRefresh,
            }}
          />
        </div>
      ) : loading ? (
        <div className={DETAIL_PANEL_TOKENS.primaryContainer}>
          <Placeholder variant="loading" />
        </div>
      ) : containers.length === 0 ? (
        <div className={DETAIL_PANEL_TOKENS.primaryContainer}>
          <Placeholder
            variant="empty"
            title={emptyTitle}
            subtitle={emptySubtitle}
          />
        </div>
      ) : (
        <>
          <SettingsTable<ContainerSummary>
            columns={columns}
            rows={containers}
            getRowKey={(row) => row.id}
            headerHeight="compact"
            emptyTitle={emptyTitle}
          />
          {selectedInspect ? (
            <div className="mt-3 rounded-lg border border-border-2 bg-primary-container p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-text-1">
                    {selectedInspect.summary.display_name}
                  </div>
                  <div className="text-[12px] text-text-3">
                    {selectedInspect.summary.id}
                  </div>
                </div>
                <Button
                  variant="tertiary"
                  size="mini"
                  onClick={() => setSelectedInspect(null)}
                >
                  {t("common:actions.close")}
                </Button>
              </div>
              <div className="grid gap-2 text-[12px] text-text-2 md:grid-cols-2">
                <div>
                  {t("navigation:launchpad.containers.startedAt")}:{" "}
                  {selectedInspect.started_at ?? "—"}
                </div>
                <div>
                  {t("navigation:launchpad.containers.finishedAt")}:{" "}
                  {selectedInspect.finished_at ?? "—"}
                </div>
                <div>
                  {t("navigation:launchpad.containers.restartCount")}:{" "}
                  {selectedInspect.restart_count ?? 0}
                </div>
                <div>
                  {t("navigation:launchpad.containers.workingDir")}:{" "}
                  {selectedInspect.working_dir ?? "—"}
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </CollapsibleSection>
  );
};

export default ContainersSection;
