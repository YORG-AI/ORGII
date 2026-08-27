import { Plus, RefreshCw, Trash2 } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import SettingsTable, {
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import Switch from "@src/components/Switch";
import TabPill, { type TabPillItem } from "@src/components/TabPill";
import type { CursorRepo } from "@src/hooks/policies";
import { getInstalledSkillIdentity } from "@src/hooks/skills/installedSkillsMerge";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  DETAIL_PANEL_TOKENS,
  ScrollPreservation,
} from "@src/modules/shared/layouts/blocks";
import { SKILL_SOURCE } from "@src/types/extensions";
import type { HubSkillDetail, InstalledSkill } from "@src/types/extensions";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import { selectedRowClassName } from "../../Tables/shared";
import type { DetailMode } from "../../types";
import {
  getSkillResolvedSourceLabel,
  getSkillStorageLocationLabel,
  isUserSkill,
  normalizeSkillPath,
  resolveSkillWorkspacePath,
} from "../skillSourceLabel";
import FindSkillsSection from "./FindSkillsSection";
import InlineExternalSkillsImport from "./InlineExternalSkillsImport";
import SkillInlineExpandedCard from "./SkillInlineExpandedCard";
import {
  SkillNameCell,
  SkillSourceCell,
  SkillStorageCell,
} from "./SkillTableParts";
import SkillViewButton from "./SkillViewButton";

type SourceFilterKey = "all" | "user" | "builtIn" | `workspace:${string}`;

interface SkillsTableProps {
  skills: InstalledSkill[];
  loading: boolean;
  selectedRowId?: string | null;
  onSelect: (name: string, mode?: DetailMode) => void;
  onCreate: () => void;
  hubDetail?: HubSkillDetail | null;
  onToggleSkill?: (name: string, enabled: boolean) => void;
  onUninstallSkill?: (name: string) => Promise<void> | void;
  onRefreshSkills?: (
    workspacePaths?: string[],
    options?: { scoped?: boolean }
  ) => Promise<void> | void;
  cursorRepos?: CursorRepo[];
  importExpanded?: boolean;
  onImportCompleted?: () => void;
  onAfterImport?: () => void | Promise<void>;
  /** Omit outer panel chrome (add-button, self-owned header) when nested under ToolsCategoryView. */
  embedded?: boolean;
}

export const SkillsTable: React.FC<SkillsTableProps> = ({
  skills,
  loading,
  selectedRowId,
  onSelect,
  onCreate,
  cursorRepos,
  importExpanded,
  onImportCompleted,
  onAfterImport,
  embedded = false,
  hubDetail,
  onToggleSkill,
  onUninstallSkill,
  onRefreshSkills,
}) => {
  const { t } = useTranslation("integrations");
  const [searchQuery, setSearchQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilterKey>("all");
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [refreshingSkills, setRefreshingSkills] = useState(false);
  const [uninstallingSkillNames, setUninstallingSkillNames] = useState<
    Set<string>
  >(new Set());

  const sourceTabs = useMemo<TabPillItem[]>(() => {
    const seenWorkspacePaths = new Set<string>();
    const workspaceTabs = (cursorRepos ?? []).flatMap((repo) => {
      const workspacePath = normalizeSkillPath(repo.path);
      if (seenWorkspacePaths.has(workspacePath)) return [];
      seenWorkspacePaths.add(workspacePath);
      return [
        {
          key: `workspace:${workspacePath}`,
          label:
            repo.name.length > 20 ? `${repo.name.slice(0, 20)}…` : repo.name,
        },
      ];
    });

    return [
      { key: "all", label: t("common:actions.all") },
      { key: "user", label: t("scopeLabels.user") },
      { key: "builtIn", label: t("scopeLabels.builtIn") },
      ...workspaceTabs,
    ];
  }, [cursorRepos, t]);

  const filtered = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return skills.filter((skill) => {
      if (uninstallingSkillNames.has(skill.name)) return false;
      const workspacePath = resolveSkillWorkspacePath(skill);
      const isBuiltIn = skill.source === SKILL_SOURCE.EMBEDDED_BUILTIN;
      const matchesSource =
        sourceFilter === "all" ||
        (sourceFilter === "builtIn" && isBuiltIn) ||
        (sourceFilter === "user" && isUserSkill(skill, cursorRepos)) ||
        (workspacePath != null &&
          sourceFilter === `workspace:${workspacePath}`);
      if (!matchesSource) return false;
      if (!query) return true;

      const sourceLabel = getSkillResolvedSourceLabel(
        t,
        skill,
        cursorRepos
      ).toLowerCase();
      return (
        skill.name.toLowerCase().includes(query) ||
        skill.description.toLowerCase().includes(query) ||
        sourceLabel.includes(query)
      );
    });
  }, [
    cursorRepos,
    searchQuery,
    skills,
    sourceFilter,
    t,
    uninstallingSkillNames,
  ]);

  useEffect(() => {
    const validRowKeys = new Set(filtered.map(getInstalledSkillIdentity));
    setExpandedKeys((current) => {
      const next = current.filter((key) => validRowKeys.has(key));
      return next.length === current.length ? current : next;
    });
  }, [filtered]);

  const handleUninstallSkill = useCallback(
    async (skill: InstalledSkill) => {
      if (!onUninstallSkill) return;
      const confirmed = await confirmDestructiveAction({
        title: t("skillsHub.deleteConfirmTitle", { name: skill.name }),
        message: t("skillsHub.deleteConfirmMessage"),
        okLabel: t("common:actions.delete"),
        cancelLabel: t("common:actions.cancel"),
      });
      if (!confirmed) return;

      setUninstallingSkillNames((current) => new Set(current).add(skill.name));
      try {
        await onUninstallSkill(skill.name);
        setExpandedKeys((current) =>
          current.filter((key) => key !== skill.name)
        );
      } finally {
        setUninstallingSkillNames((current) => {
          const next = new Set(current);
          next.delete(skill.name);
          return next;
        });
      }
    },
    [onUninstallSkill, t]
  );

  const columns = useMemo<SettingsTableColumn<InstalledSkill>[]>(
    () => [
      {
        key: "name",
        label: t("common:labels.name"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (rowA, rowB) => rowA.name.localeCompare(rowB.name),
        renderCell: (skill) => <SkillNameCell skill={skill} />,
      },
      {
        key: "source",
        label: t("common:labels.source"),
        width: SETTINGS_TABLE_COL.valueLg,
        sorter: (rowA, rowB) =>
          getSkillResolvedSourceLabel(t, rowA, cursorRepos).localeCompare(
            getSkillResolvedSourceLabel(t, rowB, cursorRepos)
          ),
        renderCell: (skill) => (
          <SkillSourceCell skill={skill} t={t} cursorRepos={cursorRepos} />
        ),
      },
      {
        key: "storage",
        label: t("skillPreview.location"),
        width: SETTINGS_TABLE_COL.valueLg,
        sorter: (rowA, rowB) =>
          getSkillStorageLocationLabel(t, rowA, cursorRepos).localeCompare(
            getSkillStorageLocationLabel(t, rowB, cursorRepos)
          ),
        renderCell: (skill) => (
          <SkillStorageCell skill={skill} t={t} cursorRepos={cursorRepos} />
        ),
      },
      {
        key: "actions",
        label: "",
        width: SETTINGS_TABLE_COL.hug,
        align: "right",
        renderCell: (skill) => {
          const isBuiltIn = skill.source === SKILL_SOURCE.EMBEDDED_BUILTIN;
          const showRemove = Boolean(onUninstallSkill);
          const canRemove = showRemove && !isBuiltIn;
          const uninstalling = uninstallingSkillNames.has(skill.name);

          return (
            <div className="flex h-full items-center justify-end gap-2">
              {onToggleSkill && (
                <div
                  className="flex h-full items-center"
                  onClick={(event) => event.stopPropagation()}
                >
                  <Switch
                    size="small"
                    checked={skill.enabled}
                    onCheckedChange={(checked) =>
                      onToggleSkill(skill.name, checked)
                    }
                  />
                </div>
              )}
              <div onClick={(event) => event.stopPropagation()}>
                <SkillViewButton skill={skill} />
              </div>
              {showRemove ? (
                <Button
                  variant="secondary"
                  size="small"
                  icon={<Trash2 size={14} className="text-danger-6" />}
                  iconOnly
                  loading={uninstalling}
                  disabled={!canRemove || uninstalling}
                  aria-label={t("common:actions.remove")}
                  title={t("common:actions.remove")}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (canRemove) {
                      void handleUninstallSkill(skill);
                    }
                  }}
                />
              ) : null}
            </div>
          );
        },
      },
    ],
    [
      cursorRepos,
      handleUninstallSkill,
      onToggleSkill,
      onUninstallSkill,
      t,
      uninstallingSkillNames,
    ]
  );

  const handleRefreshSkills = useCallback(async () => {
    if (!onRefreshSkills) return;
    const workspacePrefix = "workspace:";
    const scopedWorkspacePaths = sourceFilter.startsWith(workspacePrefix)
      ? [sourceFilter.slice(workspacePrefix.length)]
      : [];
    const scopedRefresh = sourceFilter !== "all";
    setRefreshingSkills(true);
    try {
      await onRefreshSkills(scopedWorkspacePaths, { scoped: scopedRefresh });
    } finally {
      setRefreshingSkills(false);
    }
  }, [onRefreshSkills, sourceFilter]);

  const { spinClass: refreshSpinClass, handleClick: handleRefreshClick } =
    useRefreshSpin(handleRefreshSkills, refreshingSkills || loading);

  const tableActions = (
    <div className="flex items-center gap-2">
      {onRefreshSkills ? (
        <Button
          variant="secondary"
          size="default"
          icon={<RefreshCw size={14} className={refreshSpinClass} />}
          iconOnly
          disabled={refreshingSkills || loading}
          aria-label={t("common:actions.refresh")}
          title={t("common:actions.refresh")}
          onClick={handleRefreshClick}
          data-testid="integrations-skills-refresh-button"
        />
      ) : null}
      <Button
        variant="secondary"
        size="default"
        icon={<Plus size={14} />}
        onClick={onCreate}
        data-testid="integrations-skills-create-button"
      >
        {t("addOptions.createSkill")}
      </Button>
    </div>
  );

  const handleRowClick = useCallback(
    (skill: InstalledSkill) => {
      const skillIdentity = getInstalledSkillIdentity(skill);
      onSelect(skill.name);
      setExpandedKeys((current) =>
        current.includes(skillIdentity) ? [] : [skillIdentity]
      );
    },
    [onSelect]
  );

  const installedPanel = (
    <ScrollPreservation className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
      <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
        <div className="flex flex-col gap-3">
          <SettingsTable<InstalledSkill>
            hover
            loading={loading}
            columns={columns}
            rows={filtered}
            getRowKey={getInstalledSkillIdentity}
            onRowClick={handleRowClick}
            rowClassName={selectedRowClassName(
              (sk: InstalledSkill) => sk.name,
              selectedRowId
            )}
            headerHeight="tall"
            searchBar={{
              searchValue: searchQuery,
              onSearchChange: setSearchQuery,
              searchPlaceholder: t("skillsHub.searchPlaceholder"),
              allowSearchClear: true,
              rightContent: tableActions,
              tabPills: (
                <TabPill
                  tabs={sourceTabs}
                  activeTab={sourceFilter}
                  onChange={(key) => setSourceFilter(key as SourceFilterKey)}
                  variant="pill"
                  appearance="ghost"
                  fillWidth={false}
                  size="mini"
                />
              ),
            }}
            emptyTitle={t("skillsHub.noInstalled")}
            emptyAction={{
              label: t("addOptions.createSkill"),
              onClick: onCreate,
            }}
            expandable={{
              expandedRowKeys: expandedKeys,
              onExpandedRowsChange: (keys) => setExpandedKeys(keys.slice(-1)),
              expandedRowRender: (skill) => (
                <SkillInlineExpandedCard
                  skill={skill}
                  hubDetail={hubDetail}
                  cursorRepos={cursorRepos}
                />
              ),
            }}
          />
          <InlineExternalSkillsImport
            cursorRepos={cursorRepos}
            forceExpanded={importExpanded}
            onCompleted={onImportCompleted}
            onAfterImport={onAfterImport}
          />
          <FindSkillsSection />
        </div>
      </div>
    </ScrollPreservation>
  );

  if (embedded) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {installedPanel}
        </div>
      </div>
    );
  }

  return installedPanel;
};
