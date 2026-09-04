/**
 * Agent Org TeamMemberTable — inline-editable table for agent team members.
 *
 * Built on the shared DragTable component for drag-to-reorder.
 * Supports hierarchy via optional parentId field + "Reports to" column.
 */
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import DragTable, { type DragTableColumn } from "@src/components/DragTable";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DropdownFooter,
} from "@src/components/Dropdown/exports";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import { Add01Icon, Delete02Icon, HugeiconsIcon } from "@src/icons";
import type { OrgMemberRuntimeConfig } from "@src/modules/MainApp/AgentOrgs/types";

// ── Types ──

export interface TeamMember {
  id: string;
  name: string;
  role: string;
  agentId: string;
  runtimeConfig?: OrgMemberRuntimeConfig;
  parentId?: string;
}

interface TeamMemberTableProps {
  members: TeamMember[];
  onChange: (members: TeamMember[]) => void;
  agentOptions: SelectOption[];
  /** Callback when user clicks "+ Add Agent" in the agent selector */
  onAddAgent?: () => void;
  /** Header height: "compact" (32px) or "tall" (40px, default) — matches SettingsTable */
  headerHeight?: "compact" | "tall";
  /**
   * IDs of rows whose `name` should render with an error state (e.g. duplicate
   * names within an Agent Team's routing namespace). The table itself is
   * routing-agnostic; callers decide what counts as an error.
   */
  invalidNameRowIds?: ReadonlySet<string>;
  /** Tooltip surfaced on the name input for rows in `invalidNameRowIds`. */
  invalidNameMessage?: string;
  /**
   * Hide the `Reports to` column entirely. Used by callers (Agent Team
   * wizard) when the underlying hierarchy mode treats reports-to as
   * meaningless — e.g. `HierarchyMode.flat`. The `parentId` field on
   * each row is still preserved on the wire so toggling the column back
   * on does not lose data.
   */
  hideReportsTo?: boolean;
  /**
   * IDs of rows whose `parentId` should render with a warning state
   * (e.g. members without a manager in `HierarchyMode.strict`, where
   * they can only reach the coordinator). Independent from
   * `invalidNameRowIds`; both can apply to the same row.
   */
  warnReportsToRowIds?: ReadonlySet<string>;
  /** Tooltip surfaced on the reports-to cell for rows in `warnReportsToRowIds`. */
  warnReportsToMessage?: string;
  dataTestIdPrefix?: string;
  labels?: {
    name?: string;
    role?: string;
    agent?: string;
    reportsTo?: string;
    reportsToCoordinator?: string;
    addMember?: string;
    namePlaceholder?: string;
    rolePlaceholder?: string;
    empty?: string;
  };
}

// ── Agent Select with footer action ──

interface AgentSelectProps {
  value: string;
  options: SelectOption[];
  onAddAgent?: () => void;
  onChange: (value: string) => void;
  dataTestId?: string;
}

const AgentSelect: React.FC<AgentSelectProps> = ({
  value,
  options,
  onAddAgent,
  onChange,
  dataTestId,
}) => {
  const { t } = useTranslation();

  const handleChange = useCallback(
    (val: string | number | (string | number)[]) => {
      const strVal = String(val);
      onChange(strVal);
    },
    [onChange]
  );

  const dropdownRender = useCallback(
    (menu: React.ReactNode) => (
      <div className="flex min-h-0 flex-1 flex-col">
        {menu}
        {onAddAgent && (
          <DropdownFooter>
            <button
              type="button"
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full justify-start`}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onAddAgent();
              }}
            >
              <HugeiconsIcon
                icon={Add01Icon}
                data-icon="plus"
                size={DROPDOWN_ITEM.iconSize}
                strokeWidth={1.75}
              />
              <span>{t("common:actions.add")} Agent</span>
            </button>
          </DropdownFooter>
        )}
      </div>
    ),
    [onAddAgent, t]
  );

  return (
    <Select
      value={value}
      options={options}
      onChange={handleChange}
      showSearch
      size="default"
      className="w-full"
      dataTestId={dataTestId}
      dropdownRender={onAddAgent ? dropdownRender : undefined}
    />
  );
};

// ── Constants ──

const COORDINATOR_PARENT_VALUE = "__coordinator__";

// ── Main Component ──

const TeamMemberTable: React.FC<TeamMemberTableProps> = ({
  members,
  onChange,
  agentOptions,
  onAddAgent,
  headerHeight = "tall",
  invalidNameRowIds,
  invalidNameMessage,
  hideReportsTo = false,
  warnReportsToRowIds,
  warnReportsToMessage,
  dataTestIdPrefix,
  labels = {},
}) => {
  const { t } = useTranslation();

  const nameLabel = labels.name ?? "Name";
  const roleLabel = labels.role ?? "Role";
  const agentLabel = labels.agent ?? "Agent";
  const reportsToLabel = labels.reportsTo ?? "Reports to";
  const reportsToCoordinatorLabel =
    labels.reportsToCoordinator ?? "Coordinator";
  const addLabel = labels.addMember ?? t("actions.add");
  const namePlaceholder = labels.namePlaceholder ?? "";
  const rolePlaceholder = labels.rolePlaceholder ?? "";
  const emptyLabel = labels.empty ?? "No members yet";

  const parentOptionsMap = useMemo(() => {
    const map = new Map<string, SelectOption[]>();
    const coordinatorOption: SelectOption = {
      label: reportsToCoordinatorLabel,
      value: COORDINATOR_PARENT_VALUE,
      dataTestId: dataTestIdPrefix
        ? `${dataTestIdPrefix}-reports-to-coordinator`
        : undefined,
    };
    for (const member of members) {
      const others = members
        .filter((other) => other.id !== member.id)
        .map((other) => ({
          label: other.name || t("common:placeholders.untitled"),
          value: other.id,
          dataTestId: dataTestIdPrefix
            ? `${dataTestIdPrefix}-reports-to-${other.id}`
            : undefined,
        }));
      map.set(member.id, [coordinatorOption, ...others]);
    }
    return map;
  }, [members, t, dataTestIdPrefix, reportsToCoordinatorLabel]);

  const buildDataTestId = useCallback(
    (row: TeamMember, field: string) =>
      dataTestIdPrefix ? `${dataTestIdPrefix}-${row.id}-${field}` : undefined,
    [dataTestIdPrefix]
  );

  const updateMember = useCallback(
    (id: string, field: keyof TeamMember, value: string) => {
      onChange(
        members.map((member) =>
          member.id === id ? { ...member, [field]: value } : member
        )
      );
    },
    [members, onChange]
  );

  const removeMember = useCallback(
    (id: string) => {
      onChange(
        members
          .filter((member) => member.id !== id)
          .map((member) =>
            member.parentId === id ? { ...member, parentId: undefined } : member
          )
      );
    },
    [members, onChange]
  );

  const addMember = useCallback(() => {
    const newMember: TeamMember = {
      id: crypto.randomUUID(),
      name: "",
      role: "",
      agentId: agentOptions[0]?.value?.toString() ?? "",
      parentId: undefined,
    };
    onChange([...members, newMember]);
  }, [members, onChange, agentOptions]);

  const columns = useMemo<DragTableColumn<TeamMember>[]>(() => {
    const baseColumns: DragTableColumn<TeamMember>[] = [
      {
        key: "name",
        label: nameLabel,
        renderCell: (row) => {
          const hasNameError = invalidNameRowIds?.has(row.id) ?? false;
          return (
            <Input
              value={row.name}
              onChange={(val) => updateMember(row.id, "name", val)}
              placeholder={namePlaceholder}
              size="default"
              className="w-full"
              data-testid={buildDataTestId(row, "name-input")}
              error={hasNameError}
              title={hasNameError ? invalidNameMessage : undefined}
            />
          );
        },
      },
      {
        key: "role",
        label: roleLabel,
        renderCell: (row) => (
          <Input
            value={row.role}
            onChange={(val) => updateMember(row.id, "role", val)}
            placeholder={rolePlaceholder}
            size="default"
            className="w-full"
            data-testid={buildDataTestId(row, "role-input")}
          />
        ),
      },
      {
        key: "agent",
        label: agentLabel,
        renderCell: (row) => (
          <AgentSelect
            value={row.agentId}
            options={agentOptions}
            onAddAgent={onAddAgent}
            onChange={(val) => updateMember(row.id, "agentId", val)}
            dataTestId={buildDataTestId(row, "agent-select")}
          />
        ),
      },
    ];

    if (!hideReportsTo) {
      baseColumns.push({
        key: "reportsTo",
        label: reportsToLabel,
        renderCell: (row) => {
          const warn = warnReportsToRowIds?.has(row.id) ?? false;
          return (
            <div title={warn ? warnReportsToMessage : undefined}>
              <Select
                value={row.parentId || COORDINATOR_PARENT_VALUE}
                options={parentOptionsMap.get(row.id) ?? []}
                showSearch
                size="default"
                className={`w-full ${warn ? "team-member-table__reports-to--warn" : ""}`}
                dataTestId={buildDataTestId(row, "reports-to-select")}
                onChange={(val) =>
                  updateMember(
                    row.id,
                    "parentId",
                    String(val) === COORDINATOR_PARENT_VALUE ? "" : String(val)
                  )
                }
              />
            </div>
          );
        },
      });
    }

    baseColumns.push({
      key: "actions",
      width: 48,
      renderCell: (row) => (
        <Button
          variant="secondary"
          size="default"
          icon={
            <HugeiconsIcon
              icon={Delete02Icon}
              data-icon="trash-2"
              size={DROPDOWN_ITEM.iconSize}
              className="text-danger-6"
            />
          }
          iconOnly
          data-testid={buildDataTestId(row, "remove-button")}
          onClick={() => removeMember(row.id)}
        />
      ),
    });

    return baseColumns;
  }, [
    nameLabel,
    roleLabel,
    agentLabel,
    reportsToLabel,
    namePlaceholder,
    rolePlaceholder,
    agentOptions,
    onAddAgent,
    parentOptionsMap,
    updateMember,
    removeMember,
    buildDataTestId,
    invalidNameRowIds,
    invalidNameMessage,
    hideReportsTo,
    warnReportsToRowIds,
    warnReportsToMessage,
  ]);

  return (
    <DragTable<TeamMember>
      columns={columns}
      rows={members}
      onChange={onChange}
      headerHeight={headerHeight}
      onAdd={addMember}
      addLabel={addLabel}
      addButtonDataTestId={
        dataTestIdPrefix ? `${dataTestIdPrefix}-add-member-button` : undefined
      }
      emptyText={emptyLabel}
    />
  );
};

export default TeamMemberTable;
