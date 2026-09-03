import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Checkbox from "@src/components/Checkbox";
import DragTable, { type DragTableColumn } from "@src/components/DragTable";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DropdownFooter,
} from "@src/components/Dropdown/exports";
import Input from "@src/components/Input";
import Select, { type SelectOption } from "@src/components/Select";
import { Add01Icon, Delete02Icon, HugeiconsIcon } from "@src/icons";
import type { OrgMemberRuntimeConfig } from "@src/modules/MainApp/AgentOrgs/types";

export interface TeamMember {
  id: string;
  name: string;
  role: string;
  agentId: string;
  runtimeConfig?: OrgMemberRuntimeConfig;
}

interface TeamMemberTableProps {
  members: TeamMember[];
  onChange: (members: TeamMember[]) => void;
  agentOptions: SelectOption[];
  writerMemberIds: ReadonlySet<string>;
  connectedCountByMemberId: ReadonlyMap<string, number>;
  onWriterChange: (memberId: string, checked: boolean) => void;
  onManageCommunication: (memberId: string) => void;
  onMemberAdded?: (memberId: string) => void;
  onMemberRemoved?: (memberId: string) => void;
  onAddAgent?: () => void;
  headerHeight?: "compact" | "tall";
  invalidNameRowIds?: ReadonlySet<string>;
  invalidNameMessage?: string;
  dataTestIdPrefix?: string;
  labels?: {
    name?: string;
    role?: string;
    agent?: string;
    writer?: string;
    connected?: string;
    connectedCount?: (count: number) => string;
    manageCommunication?: string;
    addMember?: string;
    namePlaceholder?: string;
    rolePlaceholder?: string;
    empty?: string;
  };
}

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
  const dropdownRender = useCallback(
    (menu: React.ReactNode) => (
      <div className="flex min-h-0 flex-1 flex-col">
        {menu}
        {onAddAgent ? (
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
        ) : null}
      </div>
    ),
    [onAddAgent, t]
  );
  return (
    <Select
      value={value}
      options={options}
      onChange={(next) => onChange(String(next))}
      showSearch
      size="default"
      className="w-full"
      dataTestId={dataTestId}
      dropdownRender={onAddAgent ? dropdownRender : undefined}
    />
  );
};

const TeamMemberTable: React.FC<TeamMemberTableProps> = ({
  members,
  onChange,
  agentOptions,
  writerMemberIds,
  connectedCountByMemberId,
  onWriterChange,
  onManageCommunication,
  onMemberAdded,
  onMemberRemoved,
  onAddAgent,
  headerHeight = "tall",
  invalidNameRowIds,
  invalidNameMessage,
  dataTestIdPrefix,
  labels = {},
}) => {
  const { t } = useTranslation();
  const buildDataTestId = useCallback(
    (row: TeamMember, field: string) =>
      dataTestIdPrefix ? `${dataTestIdPrefix}-${row.id}-${field}` : undefined,
    [dataTestIdPrefix]
  );
  const updateMember = useCallback(
    (id: string, field: "name" | "role" | "agentId", value: string) => {
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
      onChange(members.filter((member) => member.id !== id));
      onMemberRemoved?.(id);
    },
    [members, onChange, onMemberRemoved]
  );
  const addMember = useCallback(() => {
    const id = crypto.randomUUID();
    onChange([
      ...members,
      {
        id,
        name: "",
        role: "",
        agentId: agentOptions[0]?.value?.toString() ?? "",
      },
    ]);
    onMemberAdded?.(id);
  }, [agentOptions, members, onChange, onMemberAdded]);

  const columns = useMemo<DragTableColumn<TeamMember>[]>(
    () => [
      {
        key: "name",
        label: labels.name ?? "Name",
        renderCell: (row) => (
          <Input
            value={row.name}
            onChange={(value) => updateMember(row.id, "name", value)}
            placeholder={labels.namePlaceholder}
            size="default"
            className="w-full"
            data-testid={buildDataTestId(row, "name-input")}
            error={invalidNameRowIds?.has(row.id) ?? false}
            title={
              invalidNameRowIds?.has(row.id) ? invalidNameMessage : undefined
            }
          />
        ),
      },
      {
        key: "role",
        label: labels.role ?? "Role",
        renderCell: (row) => (
          <Input
            value={row.role}
            onChange={(value) => updateMember(row.id, "role", value)}
            placeholder={labels.rolePlaceholder}
            size="default"
            className="w-full"
            data-testid={buildDataTestId(row, "role-input")}
          />
        ),
      },
      {
        key: "agent",
        label: labels.agent ?? "Agent",
        renderCell: (row) => (
          <AgentSelect
            value={row.agentId}
            options={agentOptions}
            onAddAgent={onAddAgent}
            onChange={(value) => updateMember(row.id, "agentId", value)}
            dataTestId={buildDataTestId(row, "agent-select")}
          />
        ),
      },
      {
        key: "writer",
        label: labels.writer ?? "Writer",
        width: 88,
        renderCell: (row) => (
          <span data-testid={buildDataTestId(row, "writer-checkbox")}>
            <Checkbox
              checked={writerMemberIds.has(row.id)}
              onCheckedChange={(checked) => onWriterChange(row.id, checked)}
              ariaLabel={`${row.name || row.id} ${labels.writer ?? "Writer"}`}
            />
          </span>
        ),
      },
      {
        key: "communication",
        label: labels.connected ?? "Connected",
        width: 180,
        renderCell: (row) => (
          <div className="flex items-center justify-between gap-2 whitespace-nowrap">
            <span
              className="text-xs text-text-3"
              data-testid={buildDataTestId(row, "connected-count")}
            >
              {labels.connectedCount?.(
                connectedCountByMemberId.get(row.id) ?? 0
              ) ??
                `${labels.connected ?? "Connected"} ${connectedCountByMemberId.get(row.id) ?? 0}`}
            </span>
            <Button
              variant="secondary"
              size="small"
              onClick={() => onManageCommunication(row.id)}
              data-testid={buildDataTestId(row, "manage-communication")}
            >
              {labels.manageCommunication ?? "Manage communication"}
            </Button>
          </div>
        ),
      },
      {
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
            aria-label={t("common:actions.delete")}
            data-testid={buildDataTestId(row, "remove-button")}
            onClick={() => removeMember(row.id)}
          />
        ),
      },
    ],
    [
      agentOptions,
      buildDataTestId,
      connectedCountByMemberId,
      invalidNameMessage,
      invalidNameRowIds,
      labels,
      onAddAgent,
      onManageCommunication,
      onWriterChange,
      removeMember,
      t,
      updateMember,
      writerMemberIds,
    ]
  );

  return (
    <DragTable
      columns={columns}
      rows={members}
      onChange={onChange}
      headerHeight={headerHeight}
      onAdd={members.length < 50 ? addMember : undefined}
      addLabel={labels.addMember ?? t("common:actions.add")}
      addButtonDataTestId={
        dataTestIdPrefix ? `${dataTestIdPrefix}-add-member-button` : undefined
      }
      emptyText={labels.empty ?? "No members yet"}
    />
  );
};

export default TeamMemberTable;
