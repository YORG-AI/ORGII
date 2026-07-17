import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { RoutineDefinition, RoutineFire } from "@src/api/http/project";
import { projectApi } from "@src/api/http/project";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import Switch from "@src/components/Switch";
import TabPill from "@src/components/TabPill";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  InternalHeader,
  ScrollPreservation,
} from "@src/modules/shared/layouts/blocks";
import { InfoRow } from "@src/modules/shared/layouts/blocks/InfoRow";

import {
  InlineCardBody,
  InlineCardColumnStack,
  InlineCardFooter,
  InlineCardShell,
  InlineCardSplit,
} from "../../KeyVault/shared/InlineCardPrimitives";
import {
  RowChevron,
  StatusDot,
  selectedRowClassName,
} from "../../Tables/shared";
import InlineActionsBar from "../../shared/InlineActionsBar";
import type { DetailMode } from "../../types";

interface RoutinesTableProps {
  routines: RoutineDefinition[];
  loading: boolean;
  selectedRowId?: string | null;
  onSelectRoutine: (id: string | null, mode?: DetailMode) => void;
  onAdd: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onToggleEnabled?: (enabled: boolean) => void;
  onFire?: () => void;
}

const FIRE_STATUS_COLOR: Record<string, string> = {
  pending: "bg-warning-6",
  started: "bg-primary-6",
  succeeded: "bg-success-6",
  failed: "bg-danger-6",
  skipped: "bg-fill-3",
  coalesced: "bg-fill-3",
  queued: "bg-warning-6",
};

/** Expanded-row fire history list, lazily fetched per routine. */
const RoutineFireHistory: React.FC<{ routineId: string }> = ({ routineId }) => {
  const { t } = useTranslation("integrations");
  const [fires, setFires] = useState<RoutineFire[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    projectApi.listRoutineFires(routineId).then((result) => {
      if (!cancelled) setFires(result);
    });
    return () => {
      cancelled = true;
    };
  }, [routineId]);

  if (fires === null) return null;
  if (fires.length === 0) {
    return (
      <span className="text-[12px] text-text-3">
        {t("routineFields.noFires")}
      </span>
    );
  }

  return (
    <div
      className="flex max-h-48 flex-col gap-1 overflow-y-auto"
      data-testid={`integrations-routine-fires-${routineId}`}
    >
      {fires.slice(0, 20).map((fire) => (
        <div
          key={fire.id}
          className="flex items-center gap-2 text-[12px] text-text-2"
        >
          <StatusDot
            color={FIRE_STATUS_COLOR[fire.status] ?? "bg-fill-3"}
            label={fire.status}
          />
          <span className="text-text-3">
            {new Date(fire.firedAt).toLocaleString()}
          </span>
          {fire.sessionId && (
            <span className="truncate text-text-4">{fire.sessionId}</span>
          )}
          {fire.workItemId && (
            <span className="truncate text-text-4">{fire.workItemId}</span>
          )}
        </div>
      ))}
    </div>
  );
};

function getTriggerLabel(routine: RoutineDefinition): string {
  if (routine.trigger.kind === "one_time")
    return `One-time: ${routine.trigger.at}`;
  return `Cron: ${routine.trigger.cron}`;
}

function getNextFireLabel(routine: RoutineDefinition): string | null {
  if (!routine.enabled || !routine.nextFireAt) return null;
  const next = new Date(routine.nextFireAt);
  if (Number.isNaN(next.getTime())) return null;
  return next.toLocaleString();
}

function getRoutineTargetLabel(routine: RoutineDefinition): string {
  if (routine.runTemplate.target.kind === "agent_org") {
    return `Agent Team: ${routine.runTemplate.target.agentOrgId}`;
  }
  return routine.runTemplate.target.agentDefinitionId ?? "Default agent";
}

function getWorkspaceLabel(routine: RoutineDefinition): string {
  const workspace = routine.runTemplate.workspace;
  if (workspace.kind === "none") return "No workspace";
  if (workspace.kind === "worktree")
    return `Worktree: ${workspace.workspacePath}`;
  return workspace.workspacePath;
}

export const RoutinesTable: React.FC<RoutinesTableProps> = ({
  routines,
  loading,
  selectedRowId,
  onSelectRoutine,
  onAdd,
  onEdit,
  onDelete,
  onToggleEnabled,
  onFire,
}) => {
  const { t } = useTranslation("integrations");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);

  const filteredRoutines = useMemo(() => {
    if (!searchQuery) return routines;
    const query = searchQuery.toLowerCase();
    return routines.filter(
      (routine) =>
        routine.name.toLowerCase().includes(query) ||
        routine.runTemplate.prompt.toLowerCase().includes(query) ||
        getRoutineTargetLabel(routine).toLowerCase().includes(query)
    );
  }, [routines, searchQuery]);

  const routinesColumns = useMemo<SettingsTableColumn<RoutineDefinition>[]>(
    () => [
      {
        key: "name",
        label: t("common:labels.name"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (rowA, rowB) => rowA.name.localeCompare(rowB.name),
        renderCell: (routine) => (
          <div className="flex flex-col gap-0.5">
            <span className={`${SETTINGS_TABLE_CELL.primary} font-bold`}>
              {routine.name}
            </span>
            <span className="text-xs text-text-3">
              {getRoutineTargetLabel(routine)}
            </span>
          </div>
        ),
      },
      {
        key: "trigger",
        label: t("rulesTabs.trigger"),
        width: SETTINGS_TABLE_COL.valueLg,
        sorter: (rowA, rowB) =>
          getTriggerLabel(rowA).localeCompare(getTriggerLabel(rowB)),
        renderCell: (routine) => (
          <span className={SETTINGS_TABLE_CELL.value}>
            {getTriggerLabel(routine)}
          </span>
        ),
      },
      {
        key: "target",
        label: t("routineFields.target"),
        width: SETTINGS_TABLE_COL.valueLg,
        sorter: (rowA, rowB) =>
          getRoutineTargetLabel(rowA).localeCompare(
            getRoutineTargetLabel(rowB)
          ),
        renderCell: (routine) => (
          <span className={SETTINGS_TABLE_CELL.value}>
            {getRoutineTargetLabel(routine)}
          </span>
        ),
      },
      {
        key: "status",
        label: t("common:labels.status"),
        width: SETTINGS_TABLE_COL.valueLg,
        sorter: (rowA, rowB) => Number(rowB.enabled) - Number(rowA.enabled),
        renderCell: (routine) => (
          <StatusDot
            color={routine.enabled ? "bg-success-6" : "bg-fill-3"}
            label={routine.enabled ? t("status.enabled") : t("status.disabled")}
          />
        ),
      },
      {
        key: "actions",
        label: "",
        width: SETTINGS_TABLE_COL.hug,
        align: "right",
        renderCell: (routine) => (
          <RowChevron onClick={() => onSelectRoutine(routine.id, "full")} />
        ),
      },
    ],
    [onSelectRoutine, t]
  );

  const tab = useMemo(
    () => [
      {
        key: "routines",
        label: t("categories.routines"),
      },
    ],
    [t]
  );

  return (
    <DetailPanelContainer>
      <InternalHeader
        noPanelHeader
        contentPadding
        className={DETAIL_PANEL_TOKENS.headerWidth}
        tabs={
          <TabPill
            tabs={tab}
            activeTab="routines"
            onChange={() => {}}
            variant="simple"
            fillWidth={false}
            size="large"
          />
        }
      />
      <ScrollPreservation className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
        <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
          <div className="flex flex-col gap-3">
            <SettingsTable<RoutineDefinition>
              hover
              loading={loading}
              columns={routinesColumns}
              rows={filteredRoutines}
              getRowKey={(routine) => routine.id}
              onRowClick={(routine) =>
                onSelectRoutine(
                  selectedRowId === routine.id ? null : routine.id
                )
              }
              rowClassName={selectedRowClassName(
                (routine: RoutineDefinition) => routine.id,
                selectedRowId
              )}
              rowDataTestId={(routine) =>
                `integrations-routine-row-${routine.id}`
              }
              headerHeight="tall"
              searchBar={{
                searchValue: searchQuery,
                onSearchChange: setSearchQuery,
                searchPlaceholder: t("routines.searchPlaceholder"),
                allowSearchClear: true,
              }}
              emptyTitle={t("routines.noRoutines")}
              emptyAction={{
                label: t("addOptions.addRoutine"),
                onClick: onAdd,
              }}
              expandable={{
                expandedRowKeys: expandedKeys,
                onExpandedRowsChange: (keys) => {
                  // Inline edit/delete/fire/toggle operate on the
                  // currently-selected routine. Keep selection in sync
                  // with the expanded row so footer actions always target
                  // the routine the user is looking at.
                  const next = keys.slice(-1);
                  setExpandedKeys(next);
                  onSelectRoutine(next[0] ?? null);
                },
                expandedRowRender: (routine) => (
                  <div
                    className="w-0 min-w-full overflow-hidden"
                    data-testid={`integrations-routine-preview-${routine.id}`}
                  >
                    <InlineCardShell>
                      <InlineCardBody>
                        <InlineCardSplit
                          left={
                            <InlineCardColumnStack>
                              <InfoRow
                                label={t("rulesTabs.trigger")}
                                value={getTriggerLabel(routine)}
                              />
                              <InfoRow
                                label={t("routineFields.target")}
                                value={getRoutineTargetLabel(routine)}
                              />
                              <InfoRow
                                label={t("routineFields.workspace")}
                                value={getWorkspaceLabel(routine)}
                              />
                            </InlineCardColumnStack>
                          }
                          right={
                            <InlineCardColumnStack>
                              <InfoRow
                                label={t("routineFields.prompt")}
                                layout="vertical"
                              >
                                <span className="break-words text-[12px] text-text-2">
                                  {routine.runTemplate.prompt}
                                </span>
                              </InfoRow>
                              {getNextFireLabel(routine) && (
                                <InfoRow
                                  label={t("routineFields.nextFire")}
                                  value={getNextFireLabel(routine) ?? ""}
                                />
                              )}
                              {onToggleEnabled && (
                                <InfoRow label={t("status.enabled")}>
                                  <Switch
                                    size="small"
                                    checked={routine.enabled}
                                    dataTestId={`integrations-routine-enabled-switch-${routine.id}`}
                                    onChange={onToggleEnabled}
                                  />
                                </InfoRow>
                              )}
                              <InfoRow
                                label={t("routineFields.fireHistory")}
                                layout="vertical"
                              >
                                <RoutineFireHistory routineId={routine.id} />
                              </InfoRow>
                            </InlineCardColumnStack>
                          }
                        />
                      </InlineCardBody>
                      {(onFire || onEdit || onDelete) && (
                        <InlineCardFooter>
                          <InlineActionsBar
                            actions={[
                              onFire && {
                                key: "fire",
                                label: t("routineFields.fireNow"),
                                variant: "primary",
                                onClick: onFire,
                                dataTestId: "integrations-routine-fire-now",
                              },
                            ]}
                            onEdit={onEdit}
                            onDelete={onDelete}
                            editTestId="integrations-routine-edit"
                            deleteTestId="integrations-routine-delete"
                          />
                        </InlineCardFooter>
                      )}
                    </InlineCardShell>
                  </div>
                ),
              }}
            />
          </div>
        </div>
      </ScrollPreservation>
    </DetailPanelContainer>
  );
};
