/**
 * OrgsTable — Lists every saved Agent Team.
 *
 * Replaces the second-level sidebar list of teams. Each row opens a
 * WorkStation `agent-config` tab (`variant: "org"`) hosting the existing
 * `OrgDetailView`, so editing semantics stay identical to before.
 */
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import { Add01Icon, Delete02Icon, HugeiconsIcon } from "@src/icons";
import { openAgentConfigInWorkStation } from "@src/util/ui/openAgentConfigInWorkStation";

import type { OrgMember } from "../types";

interface OrgsTableProps {
  orgs: OrgMember[];
  loading?: boolean;
  onAddOrg: () => void;
  onDeleteOrg: (orgId: string) => void | Promise<void>;
}

function countMembers(org: OrgMember): number {
  let count = 1;
  for (const child of org.children ?? []) count += countMembers(child);
  return count;
}

const ORGS_TABLE_COL_WIDTH = {
  members: SETTINGS_TABLE_COL.valueMd,
  actions: "132px",
} as const;

const OrgsTable: React.FC<OrgsTableProps> = ({
  orgs,
  loading,
  onAddOrg,
  onDeleteOrg,
}) => {
  const { t } = useTranslation("integrations");
  const [searchQuery, setSearchQuery] = useState("");

  const filteredRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (query.length === 0) return orgs;
    return orgs.filter(
      (org) =>
        org.name.toLowerCase().includes(query) ||
        (org.description?.toLowerCase().includes(query) ?? false)
    );
  }, [orgs, searchQuery]);

  const handleView = useCallback((row: OrgMember) => {
    openAgentConfigInWorkStation({
      variant: "org",
      entityId: row.id,
      displayName: row.name,
      entitySnapshot: row,
    });
  }, []);

  const columns = useMemo<SettingsTableColumn<OrgMember>[]>(
    () => [
      {
        key: "name",
        label: t("common:labels.name", { defaultValue: "Name" }),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (rowA, rowB) => rowA.name.localeCompare(rowB.name),
        renderCell: (row) => (
          <span className={`${SETTINGS_TABLE_CELL.primary} font-bold`}>
            {row.name}
          </span>
        ),
      },
      {
        key: "members",
        label: t("agentOrgs.orgMembers", { defaultValue: "Members" }),
        width: ORGS_TABLE_COL_WIDTH.members,
        sorter: (rowA, rowB) => countMembers(rowA) - countMembers(rowB),
        renderCell: (row) => (
          <span className={SETTINGS_TABLE_CELL.value}>{countMembers(row)}</span>
        ),
      },
      {
        key: "description",
        label: t("common:labels.description", { defaultValue: "Description" }),
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (row) => (
          <span
            className={`${SETTINGS_TABLE_CELL.muted} block w-0 min-w-full max-w-full truncate`}
            title={row.description ?? undefined}
          >
            {row.description ?? ""}
          </span>
        ),
      },
      {
        key: "actions",
        label: (
          <span className="sr-only">
            {t("common:labels.actions", { defaultValue: "Actions" })}
          </span>
        ),
        width: ORGS_TABLE_COL_WIDTH.actions,
        align: "right",
        renderCell: (row) => (
          <div
            className="flex items-center justify-end gap-2 whitespace-nowrap"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <Button
              variant="secondary"
              size="small"
              data-testid={`agent-orgs-org-view-button-${row.id}`}
              onClick={() => handleView(row)}
            >
              {t("common:actions.view", { defaultValue: "View" })}
            </Button>
            <Button
              variant="danger"
              appearance="outline"
              size="small"
              icon={
                <HugeiconsIcon
                  icon={Delete02Icon}
                  data-icon="trash-2"
                  size={14}
                />
              }
              iconOnly
              data-testid={`agent-orgs-org-delete-row-button-${row.id}`}
              onClick={() => void onDeleteOrg(row.id)}
              aria-label={t("common:actions.delete", {
                defaultValue: "Delete",
              })}
              title={t("common:actions.delete", { defaultValue: "Delete" })}
            />
          </div>
        ),
      },
    ],
    [handleView, onDeleteOrg, t]
  );

  const addOrgLabel = t("agentOrgs.addOrg", { defaultValue: "Add Agent Team" });
  const addButton = (
    <Button
      variant="secondary"
      size="default"
      icon={<HugeiconsIcon icon={Add01Icon} data-icon="plus" size={14} />}
      iconOnly
      aria-label={addOrgLabel}
      title={addOrgLabel}
      data-testid="agent-orgs-add-org-button"
      onClick={onAddOrg}
    />
  );

  return (
    <SettingsTable<OrgMember>
      hover
      loading={loading}
      columns={columns}
      rows={filteredRows}
      getRowKey={(row) => row.id}
      rowDataTestId={(row) => `agent-orgs-org-row-${row.id}`}
      onRowClick={handleView}
      headerHeight="tall"
      className="table-layout-fixed"
      searchBar={{
        searchValue: searchQuery,
        onSearchChange: setSearchQuery,
        searchPlaceholder: t("agentOrgs.searchOrgs", {
          defaultValue: "Search teams…",
        }),
        allowSearchClear: true,
        rightContent: addButton,
      }}
      emptyTitle={t("agentOrgs.noOrgs", { defaultValue: "No orgs yet" })}
      emptyAction={{
        label: addOrgLabel,
        onClick: onAddOrg,
      }}
    />
  );
};

export default OrgsTable;
