/**
 * AgentSkillsTable — shared display table for OS + SDE Agent skills.
 *
 * Separated from AgentSkillsSection so that useSkills state changes
 * don't cause ScrollPreservation to thrash during scroll.
 *
 * Both OS and SDE Agent surfaces render this table using the same
 * shared formatting parts as the Integrations Skills table, while this
 * surface keeps per-agent enablement as its own action.
 */
import { Plus } from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import SettingsTable, {
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import Switch from "@src/components/Switch";
import {
  SkillNameCell,
  SkillSourceCell,
  SkillStorageCell,
} from "@src/modules/MainApp/Integrations/Skills/Table/SkillTableParts";
import SkillViewButton from "@src/modules/MainApp/Integrations/Skills/Table/SkillViewButton";
import { getSkillStorageLocationLabel } from "@src/modules/MainApp/Integrations/Skills/skillSourceLabel";

import type { SkillInfo } from "./useSkills";

interface AgentSkillsTableProps {
  skills: SkillInfo[];
  searchQuery: string;
  onSearchChange: (query: string) => void;
  toggleSkill: (name: string, enabled: boolean) => void;
  loading?: boolean;
  emptyTitle: string;
  emptySubtitle?: string;
  onAddSkill?: () => void;
  addSkillLabel?: string;
}

const AgentSkillsTable: React.FC<AgentSkillsTableProps> = ({
  skills,
  searchQuery,
  onSearchChange,
  toggleSkill,
  loading = false,
  emptyTitle,
  emptySubtitle,
  onAddSkill,
  addSkillLabel,
}) => {
  const { t } = useTranslation("settings");
  const { t: tIntegrations } = useTranslation("integrations");

  const buildTooltip = useCallback(
    (skill: SkillInfo): string | undefined => {
      const parts: string[] = [];
      if (skill.description) parts.push(skill.description);
      if (!skill.available) {
        if (skill.requiredBins.length > 0) {
          parts.push(
            t("osAgent.skillMissingBins", {
              bins: skill.requiredBins.join(", "),
            })
          );
        }
        if (skill.requiredEnv.length > 0) {
          parts.push(
            t("osAgent.skillMissingEnv", {
              vars: skill.requiredEnv.join(", "),
            })
          );
        }
      }
      if (skill.descriptionQuality === "missing") {
        parts.push("⚠ " + t("osAgent.skillNoDescription"));
      } else if (skill.descriptionQuality === "short") {
        parts.push("⚠ " + t("osAgent.skillShortDescription"));
      }
      return parts.length > 0 ? parts.join("\n") : undefined;
    },
    [t]
  );

  const addSkillButton =
    onAddSkill && addSkillLabel ? (
      <Button
        variant="secondary"
        size="default"
        icon={<Plus size={14} />}
        onClick={onAddSkill}
        data-testid="agent-orgs-add-skill-button"
      >
        {addSkillLabel}
      </Button>
    ) : undefined;

  const columns = useMemo<SettingsTableColumn<SkillInfo>[]>(
    () => [
      {
        key: "name",
        label: t("common:labels.name"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (rowA, rowB) => rowA.name.localeCompare(rowB.name),
        renderCell: (row) => <SkillNameCell skill={row} />,
        cellInfoTooltip: buildTooltip,
      },
      {
        key: "source",
        label: t("common:labels.source"),
        width: SETTINGS_TABLE_COL.valueLg,
        renderCell: (row) => <SkillSourceCell skill={row} t={tIntegrations} />,
      },
      {
        key: "storage",
        label: tIntegrations("skillPreview.location"),
        width: SETTINGS_TABLE_COL.valueLg,
        sorter: (rowA, rowB) =>
          getSkillStorageLocationLabel(tIntegrations, rowA).localeCompare(
            getSkillStorageLocationLabel(tIntegrations, rowB)
          ),
        renderCell: (row) => <SkillStorageCell skill={row} t={tIntegrations} />,
      },
      {
        key: "actions",
        label: "",
        width: SETTINGS_TABLE_COL.hug,
        align: "right",
        renderCell: (row) => (
          <div className="flex h-full items-center justify-end gap-2">
            <div
              className="flex h-full items-center"
              onClick={(event) => event.stopPropagation()}
            >
              <Switch
                size="small"
                checked={row.enabled}
                dataTestId={`agent-orgs-skill-switch-${row.name}`}
                onChange={(enabled: boolean) => toggleSkill(row.name, enabled)}
              />
            </div>
            <div onClick={(event) => event.stopPropagation()}>
              <SkillViewButton skill={row} />
            </div>
          </div>
        ),
      },
    ],
    [t, tIntegrations, buildTooltip, toggleSkill]
  );

  return (
    <SettingsTable<SkillInfo>
      loading={loading}
      columns={columns}
      rows={skills}
      getRowKey={(row) => row.name}
      rowDataTestId={(row) => `agent-orgs-skill-row-${row.name}`}
      headerHeight="tall"
      pageSize={50}
      maxHeight="min(420px, calc(100vh - 280px))"
      searchBar={{
        searchValue: searchQuery,
        onSearchChange,
        searchPlaceholder: t("skills.searchPlaceholder"),
        allowSearchClear: true,
        rightContent: addSkillButton,
      }}
      emptyTitle={emptyTitle}
      emptySubtitle={emptySubtitle}
    />
  );
};

export default AgentSkillsTable;
