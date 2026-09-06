import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  type PropertyDefinition,
  type ScopePropertyValue,
} from "@src/api/http/project";
import Select from "@src/components/Select";
import Table from "@src/components/Table";
import type { TableColumn } from "@src/components/Table/types";
import Tag from "@src/components/Tag";
import {
  HugeiconsIcon,
  LayoutThreeColumnIcon,
  LayoutTwoRowIcon,
} from "@src/icons";
import {
  GITHUB_ISSUE_STATUS_OPTIONS,
  WORK_ITEM_STATUS_OPTIONS,
} from "@src/modules/ProjectManager/config/manage";
import type { Person } from "@src/types/core/shared";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";

import { useAllCustomStatusOptions } from "../../hooks/useStatusDefinitions";
import {
  PROPERTY_FILTER_NONE_VALUE,
  comparePropertyValues,
  groupWorkItemsByProperty,
  indexScopePropertyValues,
  workItemPropertyKey,
} from "../../propertyViewModel";
import {
  TABLE_GROUP_BY_PROJECT,
  getWorkItemStatus,
  groupWorkItemsByProject,
} from "../../workItemsViewModel";

const BUILTIN_COLUMNS = [
  "shortId",
  "title",
  "status",
  "priority",
  "assignee",
  "targetDate",
  "labels",
] as const;

type BuiltinColumn = (typeof BUILTIN_COLUMNS)[number];

const DEFAULT_VISIBLE: readonly string[] = [
  "shortId",
  "title",
  "status",
  "priority",
  "assignee",
  "targetDate",
];

export interface WorkItemsTableViewProps {
  statusOrgId: string;
  items: WorkItemExtended[];
  members: Person[];
  visibleColumns: string[] | null;
  onVisibleColumnsChange: (columns: string[]) => void;
  propertyDefinitions: PropertyDefinition[];
  propertyValues: ScopePropertyValue[];
  propertyGroupBy: string | null;
  onPropertyGroupByChange: (propertyId: string | null) => void;
  tableSort: WorkItemsTableSort | null;
  onTableSortChange: (sort: WorkItemsTableSort | null) => void;
  onRowClick?: (workItem: WorkItemExtended) => void;
}

export interface WorkItemsTableSort {
  sortBy: string;
  sortDirection: "asc" | "desc";
}

function propertyColumnKey(definitionId: string): string {
  return `property:${definitionId}`;
}

function renderPropertyValue(
  definition: PropertyDefinition,
  value: unknown,
  memberNames: ReadonlyMap<string, string>
): React.ReactNode {
  if (value === null || value === undefined) return null;
  switch (definition.propertyType) {
    case "checkbox":
      return value === true ? "✓" : null;
    case "select": {
      const option = definition.config.options.find(
        (candidate) => candidate.id === value
      );
      return option ? (
        <Tag color={option.color ?? undefined}>{option.name}</Tag>
      ) : (
        String(value)
      );
    }
    case "multi_select": {
      const ids = Array.isArray(value) ? value : [];
      return (
        <span className="flex flex-wrap gap-1">
          {ids.map((id) => {
            const option = definition.config.options.find(
              (candidate) => candidate.id === id
            );
            return option ? (
              <Tag key={String(id)} color={option.color ?? undefined}>
                {option.name}
              </Tag>
            ) : null;
          })}
        </span>
      );
    }
    case "actor": {
      const reference = String(value);
      const memberId = reference.startsWith("member:")
        ? reference.slice("member:".length)
        : reference;
      return memberNames.get(memberId) ?? memberId;
    }
    case "multi_actor": {
      const references = Array.isArray(value) ? value : [];
      return (
        <span className="flex flex-wrap gap-1">
          {references.map((reference) => {
            const raw = String(reference);
            const memberId = raw.startsWith("member:")
              ? raw.slice("member:".length)
              : raw;
            return <Tag key={raw}>{memberNames.get(memberId) ?? memberId}</Tag>;
          })}
        </span>
      );
    }
    case "url":
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noreferrer"
          className="text-primary-6 hover:underline"
          onClick={(event) => event.stopPropagation()}
        >
          {String(value)}
        </a>
      );
    default:
      return String(value);
  }
}

export const WorkItemsTableView: React.FC<WorkItemsTableViewProps> = ({
  statusOrgId,
  items,
  members,
  visibleColumns,
  onVisibleColumnsChange,
  propertyDefinitions: definitions,
  propertyValues: values,
  propertyGroupBy,
  onPropertyGroupByChange,
  tableSort,
  onTableSortChange,
  onRowClick,
}) => {
  const { t } = useTranslation("projects");
  const customStatusOptions = useAllCustomStatusOptions(statusOrgId);
  const memberNames = useMemo(
    () => new Map(members.map((member) => [member.id, member.name])),
    [members]
  );

  const valuesByItem = useMemo(
    () => indexScopePropertyValues(values),
    [values]
  );

  const statusLabel = useMemo(() => {
    const all = [
      ...WORK_ITEM_STATUS_OPTIONS,
      ...GITHUB_ISSUE_STATUS_OPTIONS,
      ...customStatusOptions,
    ];
    return (status: string) =>
      all.find((option) => option.value === status)?.label ?? status;
  }, [customStatusOptions]);

  const columnOptions = useMemo(
    () => [
      ...BUILTIN_COLUMNS.map((key) => ({
        value: key as string,
        label: t(`workItems.table.columns.${key}`, { defaultValue: key }),
      })),
      ...definitions.map((definition) => ({
        value: propertyColumnKey(definition.id),
        label: definition.name,
      })),
    ],
    [definitions, t]
  );
  const groupOptions = useMemo(
    () => [
      {
        value: TABLE_GROUP_BY_PROJECT,
        label: t("workItems.propertyFields.project", {
          defaultValue: "Project",
        }),
      },
      ...definitions.map((definition) => ({
        value: definition.id,
        label: definition.name,
      })),
    ],
    [definitions, t]
  );

  const effectiveVisible = useMemo(
    () => visibleColumns ?? [...DEFAULT_VISIBLE],
    [visibleColumns]
  );

  const columns = useMemo<TableColumn<WorkItemExtended>[]>(() => {
    const builtin: Record<BuiltinColumn, TableColumn<WorkItemExtended>> = {
      shortId: {
        key: "shortId",
        title: t("workItems.table.columns.shortId", { defaultValue: "ID" }),
        width: 92,
        sorter: (a, b) => (a.shortId ?? "").localeCompare(b.shortId ?? ""),
        render: (_value, record) => (
          <span className="text-xs whitespace-nowrap text-text-3">
            {record.shortId}
          </span>
        ),
      },
      title: {
        key: "title",
        title: t("workItems.table.columns.title", { defaultValue: "Title" }),
        sorter: (a, b) => (a.name ?? "").localeCompare(b.name ?? ""),
        render: (_value, record) => (
          <span className="text-sm text-text-1">
            {record.name || t("workItems.untitledWorkItem")}
          </span>
        ),
      },
      status: {
        key: "status",
        title: t("workItems.table.columns.status", { defaultValue: "Status" }),
        width: 120,
        sorter: (a, b) =>
          getWorkItemStatus(a).localeCompare(getWorkItemStatus(b)),
        render: (_value, record) => (
          <span className="text-xs text-text-2">
            {statusLabel(getWorkItemStatus(record))}
          </span>
        ),
      },
      priority: {
        key: "priority",
        title: t("workItems.table.columns.priority", {
          defaultValue: "Priority",
        }),
        width: 96,
        sorter: (a, b) => (a.priority ?? "").localeCompare(b.priority ?? ""),
        render: (_value, record) =>
          record.priority && record.priority !== "none" ? (
            <span className="text-xs text-text-2 capitalize">
              {record.priority}
            </span>
          ) : null,
      },
      assignee: {
        key: "assignee",
        title: t("workItems.table.columns.assignee", {
          defaultValue: "Assignee",
        }),
        width: 140,
        sorter: (a, b) =>
          (a.assignee?.name ?? "").localeCompare(b.assignee?.name ?? ""),
        render: (_value, record) =>
          record.assignee ? (
            <span className="text-xs text-text-2">{record.assignee.name}</span>
          ) : null,
      },
      targetDate: {
        key: "targetDate",
        title: t("workItems.table.columns.targetDate", {
          defaultValue: "Due",
        }),
        width: 110,
        sorter: (a, b) =>
          (a.target_date ?? "").localeCompare(b.target_date ?? ""),
        render: (_value, record) =>
          record.target_date ? (
            <span className="text-xs whitespace-nowrap text-text-3">
              {record.target_date}
            </span>
          ) : null,
      },
      labels: {
        key: "labels",
        title: t("workItems.table.columns.labels", { defaultValue: "Labels" }),
        render: (_value, record) => (
          <span className="flex flex-wrap gap-1">
            {(record.labels ?? []).map((label) => (
              <Tag key={label.id} color={label.color}>
                {label.name}
              </Tag>
            ))}
          </span>
        ),
      },
    };

    const active: TableColumn<WorkItemExtended>[] = [];
    for (const key of effectiveVisible) {
      if ((BUILTIN_COLUMNS as readonly string[]).includes(key)) {
        active.push(builtin[key as BuiltinColumn]);
        continue;
      }
      if (key.startsWith("property:")) {
        const definitionId = key.slice("property:".length);
        const definition = definitions.find(
          (candidate) => candidate.id === definitionId
        );
        if (!definition) continue;
        active.push({
          key,
          title: definition.name,
          sorter: (a, b) => {
            const left = valuesByItem
              .get(workItemPropertyKey(a))
              ?.get(definitionId);
            const right = valuesByItem
              .get(workItemPropertyKey(b))
              ?.get(definitionId);
            return comparePropertyValues(definition, left, right, memberNames);
          },
          render: (_value, record) => {
            const raw = valuesByItem
              .get(workItemPropertyKey(record))
              ?.get(definitionId);
            return renderPropertyValue(definition, raw, memberNames);
          },
        });
      }
    }
    return active;
  }, [
    definitions,
    effectiveVisible,
    memberNames,
    statusLabel,
    t,
    valuesByItem,
  ]);

  const groupedRows = useMemo(() => {
    if (propertyGroupBy === TABLE_GROUP_BY_PROJECT) {
      return groupWorkItemsByProject(
        items,
        t("workItems.properties.noProject", {
          defaultValue: "No linked Project",
        })
      );
    }
    const definition = definitions.find(
      (candidate) => candidate.id === propertyGroupBy
    );
    return definition
      ? groupWorkItemsByProperty(items, definition, valuesByItem, members)
      : null;
  }, [definitions, items, members, propertyGroupBy, t, valuesByItem]);

  const renderTable = (rows: WorkItemExtended[]) => (
    <Table<WorkItemExtended>
      columns={columns}
      data={rows}
      rowKey="session_id"
      pagination={false}
      size="small"
      sorting={
        tableSort
          ? {
              column: tableSort.sortBy,
              order: tableSort.sortDirection === "desc" ? "descend" : "ascend",
            }
          : null
      }
      onSortingChange={(next) =>
        onTableSortChange(
          next
            ? {
                sortBy: next.column,
                sortDirection: next.order === "descend" ? "desc" : "asc",
              }
            : null
        )
      }
      onRowClick={onRowClick}
    />
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-2"
      data-testid="work-items-table-view"
    >
      <div className="flex items-center justify-end gap-1">
        <Select
          value={propertyGroupBy ?? undefined}
          options={groupOptions}
          onChange={(value) => onPropertyGroupByChange(String(value))}
          onClear={() => onPropertyGroupByChange(null)}
          allowClear
          showSearch
          appearance="ghost"
          size="small"
          placeholder={t("workItems.table.groupByProperty", {
            defaultValue: "Group by property",
          })}
          prefix={
            <HugeiconsIcon
              icon={LayoutTwoRowIcon}
              data-icon="rows-3"
              size={13}
            />
          }
          ariaLabel={t("workItems.table.groupByProperty", {
            defaultValue: "Group by property",
          })}
          dataTestId="work-items-table-property-group"
        />
        <Select
          mode="multiple"
          value={effectiveVisible}
          options={columnOptions}
          onChange={(next) => onVisibleColumnsChange(next as string[])}
          appearance="ghost"
          size="small"
          placeholder={t("workItems.table.columnsPicker", {
            defaultValue: "Columns",
          })}
          prefix={
            <HugeiconsIcon
              icon={LayoutThreeColumnIcon}
              data-icon="columns-3"
              size={13}
            />
          }
          ariaLabel={t("workItems.table.columnsPicker", {
            defaultValue: "Columns",
          })}
          dataTestId="work-items-table-columns"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {groupedRows ? (
          <div className="flex flex-col gap-3">
            {groupedRows.map((group) => (
              <section key={group.key} data-testid="work-items-table-group">
                <h3 className="flex items-center gap-2 px-2 py-1 text-xs font-medium text-text-2">
                  <span>
                    {group.key === PROPERTY_FILTER_NONE_VALUE
                      ? t("workItems.properties.noValue", {
                          defaultValue: "No value",
                        })
                      : group.label}
                  </span>
                  <span className="text-text-4">{group.items.length}</span>
                </h3>
                {renderTable(group.items)}
              </section>
            ))}
          </div>
        ) : (
          renderTable(items)
        )}
      </div>
    </div>
  );
};

export default WorkItemsTableView;
