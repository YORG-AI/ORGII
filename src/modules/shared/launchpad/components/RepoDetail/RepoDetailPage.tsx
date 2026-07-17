/**
 * RepoDetailPage — full detail view for a repo in the Launchpad.
 *
 * Matches Integrations' AccountDetailsPanel pattern with:
 * - Info section (project type, path, config files)
 * - Env Vars section with CRUD via SettingsTable
 * - Scripts section with CRUD via SettingsTable
 * - Analysis section with clear/refresh actions
 */
import { Copy, Trash2 } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import FileTypeIcon from "@src/components/FileTypeIcon";
import Message from "@src/components/Message";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import StatusDot from "@src/components/StatusDot";
import TabPill from "@src/components/TabPill";
import type { TabPillItem } from "@src/components/TabPill";
import {
  useContainers,
  useEnvCrud,
  useRepoContainers,
  useRepoDetection,
  useScriptCrud,
} from "@src/modules/shared/launchpad/hooks";
import type {
  EnvVar,
  RepoScript,
  ScriptCategory,
} from "@src/modules/shared/launchpad/types";
import {
  CollapsibleSection,
  DETAIL_PANEL_TOKENS,
} from "@src/modules/shared/layouts/blocks";
import { InfoRow } from "@src/modules/shared/layouts/blocks/InfoRow";
import type { Repo } from "@src/store/repo/types";
import { copyText } from "@src/util/data/clipboard";

import ContainersSection from "../ContainersSection";
import {
  STATUS_DOT_COLOR,
  STATUS_LABEL_KEY,
  STATUS_TEXT_COLOR,
} from "./RepoDetailConfig";
import { AddEnvVarRow, AddScriptRow } from "./RepoDetailForms";

// ============================================
// RepoDetailPage
// ============================================

interface RepoDetailPageProps {
  repo: Repo;
  /**
   * Optional reporter: when set, the page publishes its refresh handler
   * and loading flag so a parent (e.g. the workstation tab header) can
   * render the refresh control instead of this page owning it.
   */
  onRefreshChange?: (state: {
    refresh: () => void;
    clearAnalysis: () => void;
    loading: boolean;
  }) => void;
}

const RepoDetailPage: React.FC<RepoDetailPageProps> = ({
  repo,
  onRefreshChange,
}) => {
  const { t } = useTranslation("navigation");
  const [showAddEnv, setShowAddEnv] = useState(false);
  const [showAddScript, setShowAddScript] = useState(false);
  const [envSearch, setEnvSearch] = useState("");
  const [scriptSearch, setScriptSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");

  const repoPath = repo.path ?? "";

  const {
    repoType,
    repoTypeLabel,
    configFiles,
    hasDocker,
    hasMakefile,
    loading: detectionLoading,
    refresh: refreshDetection,
  } = useRepoDetection(repoPath);

  const {
    status: envStatus,
    vars: envVars,
    loading: envLoading,
    refresh: refreshEnv,
    addVar,
    updateVar: _updateVar,
    deleteVar,
  } = useEnvCrud(repoPath);

  const {
    scripts,
    loading: scriptsLoading,
    refresh: refreshScripts,
    addScript,
    updateScript: _updateScript,
    deleteScript,
    clearCustomScripts,
  } = useScriptCrud(repoPath, repoType);

  const {
    containers,
    loading: containersLoading,
    error: containersError,
    refresh: refreshContainers,
  } = useContainers(hasDocker);
  const repoContainers = useRepoContainers(containers, repoPath);
  const showRepoContainersSection = hasDocker;

  const repoName = useMemo(() => {
    const parts = repoPath.split("/");
    return parts[parts.length - 1] || repo.name || "Repo";
  }, [repoPath, repo.name]);

  const badges = useMemo(() => {
    const result: string[] = [];
    if (hasDocker) result.push("Docker");
    if (hasMakefile) result.push("Make");
    return result;
  }, [hasDocker, hasMakefile]);

  const loading =
    detectionLoading || envLoading || scriptsLoading || containersLoading;

  const handleRefresh = useCallback(() => {
    refreshDetection();
    refreshEnv();
    refreshScripts();
    refreshContainers();
  }, [refreshDetection, refreshEnv, refreshScripts, refreshContainers]);

  const handleClearAnalysis = useCallback(async () => {
    await clearCustomScripts();
    refreshDetection();
    refreshEnv();
    refreshScripts();
    Message.success(t("launchpad.detail.analysisCleared"));
    refreshContainers();
  }, [
    clearCustomScripts,
    refreshDetection,
    refreshEnv,
    refreshScripts,
    refreshContainers,
    t,
  ]);

  useEffect(() => {
    if (!onRefreshChange) return;
    onRefreshChange({
      refresh: handleRefresh,
      clearAnalysis: handleClearAnalysis,
      loading,
    });
  }, [onRefreshChange, handleRefresh, handleClearAnalysis, loading]);

  // ============================================
  // Env Vars Table
  // ============================================

  const envColumns = useMemo<SettingsTableColumn<EnvVar>[]>(
    () => [
      {
        key: "key",
        label: t("launchpad.detail.envKey"),
        width: "180px",
        renderCell: (row) => (
          <span
            className={`${SETTINGS_TABLE_CELL.primary} block max-w-full truncate`}
            title={row.key}
          >
            {row.key}
          </span>
        ),
      },
      {
        key: "value",
        label: t("launchpad.detail.envValue"),
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (row) => {
          const value = row.value || t("launchpad.detail.envEmpty");
          return (
            <span
              className={`${row.filled ? SETTINGS_TABLE_CELL.value : "text-warning-6"} block max-w-full truncate`}
              title={value}
            >
              {value}
            </span>
          );
        },
      },
      {
        key: "source",
        label: t("launchpad.detail.envSource"),
        width: "72px",
        renderCell: (row) => (
          <span
            className={`${SETTINGS_TABLE_CELL.muted} block max-w-full truncate`}
            title={row.source}
          >
            {row.source}
          </span>
        ),
      },
      {
        key: "actions",
        label: t("common:common.actions"),
        width: "72px",
        align: "right",
        renderCell: (row) => (
          <div className="flex w-full items-center justify-end gap-1">
            <Button
              size="small"
              iconOnly
              title={t("common:actions.delete")}
              aria-label={t("common:actions.delete")}
              icon={<Trash2 size={14} />}
              onClick={() => deleteVar(row.key)}
            />
          </div>
        ),
      },
    ],
    [t, deleteVar]
  );

  // ============================================
  // Scripts Table
  // ============================================

  const handleCopyScript = useCallback(
    async (script: RepoScript) => {
      try {
        await copyText(script.command);
        Message.success({ content: t("common:status.copied") });
      } catch {
        Message.error({ content: t("common:errors.failedToCopy") });
      }
    },
    [t]
  );

  const scriptColumns = useMemo<SettingsTableColumn<RepoScript>[]>(
    () => [
      {
        key: "name",
        label: t("launchpad.detail.scriptName"),
        width: "200px",
        renderCell: (row) => (
          <span
            className={`${SETTINGS_TABLE_CELL.primary} block max-w-full truncate`}
            title={row.name}
          >
            {row.name}
          </span>
        ),
      },
      {
        key: "command",
        label: t("launchpad.detail.scriptCommand"),
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (row) => (
          <code
            className={`${SETTINGS_TABLE_CELL.muted} block max-w-full truncate`}
            title={row.command}
          >
            {row.command}
          </code>
        ),
      },
      {
        key: "actions",
        label: t("common:common.actions"),
        width: "88px",
        align: "right",
        renderCell: (row) => (
          <div className="flex w-full items-center justify-end gap-1">
            <Button
              size="small"
              iconOnly
              title={t("common:actions.copy")}
              aria-label={t("common:actions.copy")}
              icon={<Copy size={14} />}
              onClick={() => handleCopyScript(row)}
            />
            {row.source === "custom" && (
              <Button
                size="small"
                iconOnly
                title={t("common:actions.delete")}
                aria-label={t("common:actions.delete")}
                icon={<Trash2 size={14} />}
                onClick={() => deleteScript(row.name)}
              />
            )}
          </div>
        ),
      },
    ],
    [t, handleCopyScript, deleteScript]
  );

  const categoryTabs = useMemo<TabPillItem[]>(() => {
    const counts = new Map<ScriptCategory, number>();
    for (const script of scripts) {
      counts.set(script.category, (counts.get(script.category) ?? 0) + 1);
    }
    const order: ScriptCategory[] = [
      "dev",
      "start",
      "build",
      "test",
      "lint",
      "other",
    ];
    const categoryLabelKey: Record<ScriptCategory, string> = {
      dev: "launchpad.scripts.categoryDev",
      start: "launchpad.scripts.categoryStart",
      build: "launchpad.scripts.categoryBuild",
      test: "launchpad.scripts.categoryTest",
      lint: "launchpad.scripts.categoryLint",
      other: "launchpad.scripts.categoryOther",
    };
    const tabs: TabPillItem[] = [
      { key: "all", label: t("common:filters.all") },
    ];
    for (const cat of order) {
      const count = counts.get(cat);
      if (count) {
        tabs.push({
          key: cat,
          label: `${t(categoryLabelKey[cat])} (${count})`,
        });
      }
    }
    return tabs;
  }, [scripts, t]);

  const activeCategory = categoryTabs.some(
    (tab) => tab.key === selectedCategory
  )
    ? selectedCategory
    : "all";

  const handleCategoryChange = useCallback((key: string) => {
    setSelectedCategory(key);
  }, []);

  const filteredEnvVars = useMemo(() => {
    const query = envSearch.trim().toLowerCase();
    if (!query) return envVars;
    return envVars.filter(
      (row) =>
        row.key.toLowerCase().includes(query) ||
        row.value.toLowerCase().includes(query) ||
        row.source.toLowerCase().includes(query)
    );
  }, [envVars, envSearch]);

  const filteredScripts = useMemo(() => {
    const query = scriptSearch.trim().toLowerCase();
    return scripts.filter((row) => {
      if (activeCategory !== "all" && row.category !== activeCategory) {
        return false;
      }
      if (!query) return true;
      return (
        row.name.toLowerCase().includes(query) ||
        row.command.toLowerCase().includes(query)
      );
    });
  }, [scripts, scriptSearch, activeCategory]);

  // Render directly into the parent's descriptionContent slot — no
  // outer DetailPanelContainer, no extra scroll wrapper, no width cap.
  // Scrolling and horizontal padding are owned by the enclosing
  // WorkItemContentStack, matching the Overview tab's layout exactly.
  return (
    <div className="flex flex-col">
      {/* Info Section */}
      <div className={DETAIL_PANEL_TOKENS.sectionGap}>
        <div className={DETAIL_PANEL_TOKENS.chatPanelInfoContainer}>
          <h3
            className="mb-3 truncate text-[14px] font-semibold text-text-1"
            title={repoName}
          >
            {repoName}
          </h3>
          <div className={DETAIL_PANEL_TOKENS.contentStack}>
            <InfoRow
              label={t("launchpad.preview.repoType")}
              value={repoTypeLabel}
            />
            <InfoRow label={t("launchpad.detail.path")} value={repoPath} />
            <InfoRow label={t("launchpad.preview.status")}>
              <StatusDot
                color={STATUS_DOT_COLOR[envStatus]}
                size="inline"
                labelClassName={`text-[12px] font-medium ${STATUS_TEXT_COLOR[envStatus]}`}
                label={t(STATUS_LABEL_KEY[envStatus])}
              />
            </InfoRow>
            {badges.length > 0 && (
              <InfoRow label={t("launchpad.preview.tools")}>
                <div className="flex items-center gap-1.5">
                  {badges.map((badge) => (
                    <span
                      key={badge}
                      className="rounded bg-fill-3 px-1.5 py-0.5 text-[11px] text-text-2"
                    >
                      {badge}
                    </span>
                  ))}
                </div>
              </InfoRow>
            )}
          </div>
        </div>
      </div>

      {/* Config Files */}
      {configFiles.length > 0 && (
        <CollapsibleSection title={t("launchpad.preview.configFiles")}>
          <div
            className={`${DETAIL_PANEL_TOKENS.contentStack} ${DETAIL_PANEL_TOKENS.chatPanelInfoContainer}`}
          >
            {configFiles.map((file) => (
              <div
                key={file.path}
                className="flex min-h-[24px] min-w-0 items-center gap-2"
              >
                <FileTypeIcon fileName={file.name} size="small" />
                <span
                  className="min-w-0 flex-1 truncate text-[12px] text-text-1"
                  title={file.path}
                >
                  {file.name}
                </span>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {showRepoContainersSection ? (
        <ContainersSection
          title={t("launchpad.containers.repoTitle")}
          containers={repoContainers}
          loading={containersLoading}
          error={containersError}
          onRefresh={refreshContainers}
          emptyTitle={t("launchpad.containers.repoEmptyTitle")}
          emptySubtitle={t("launchpad.containers.repoEmptySubtitle")}
        />
      ) : null}

      {/* Env Vars Section */}
      <CollapsibleSection
        title={
          envVars.length > 0
            ? `${t("launchpad.detail.envVarsTitle")} (${envVars.filter((v) => v.filled).length}/${envVars.length})`
            : t("launchpad.detail.envVarsTitle")
        }
        defaultOpen={false}
      >
        <SettingsTable<EnvVar>
          columns={envColumns}
          rows={filteredEnvVars}
          getRowKey={(row) => row.key}
          headerHeight="compact"
          surfaceVariant="chatPanel"
          emptyTitle={
            envSearch
              ? t("common:status.noResults")
              : t("launchpad.detail.noEnvVars")
          }
          className="table-layout-fixed"
          searchBar={{
            searchValue: envSearch,
            searchPlaceholder: t("launchpad.detail.searchEnvVars"),
            onSearchChange: setEnvSearch,
            onSearchClear: () => setEnvSearch(""),
            searchCountText:
              filteredEnvVars.length !== envVars.length
                ? `${filteredEnvVars.length} / ${envVars.length}`
                : undefined,
          }}
          addFooter={
            showAddEnv
              ? undefined
              : {
                  label: t("launchpad.detail.addEnvVar"),
                  onClick: () => setShowAddEnv(true),
                }
          }
        />

        {showAddEnv && (
          <div className="mt-3">
            <AddEnvVarRow onAdd={addVar} />
          </div>
        )}
      </CollapsibleSection>

      {/* Scripts Section */}
      <CollapsibleSection
        title={
          scripts.length > 0
            ? `${t("launchpad.detail.scriptsTitle")} (${scripts.length})`
            : t("launchpad.detail.scriptsTitle")
        }
        defaultOpen={false}
      >
        <SettingsTable<RepoScript>
          columns={scriptColumns}
          rows={filteredScripts}
          getRowKey={(row) => `${row.source}:${row.command}`}
          headerHeight="tall"
          surfaceVariant="chatPanel"
          className="table-layout-fixed"
          searchBar={{
            searchValue: scriptSearch,
            searchPlaceholder: t("launchpad.detail.searchScripts"),
            onSearchChange: setScriptSearch,
            onSearchClear: () => setScriptSearch(""),
            searchCountText:
              filteredScripts.length !== scripts.length
                ? `${filteredScripts.length} / ${scripts.length}`
                : undefined,
            tabPills:
              categoryTabs.length > 2 ? (
                <TabPill
                  tabs={categoryTabs}
                  activeTab={activeCategory}
                  onChange={handleCategoryChange}
                  variant="pill"
                  colorScheme="muted"
                  fillWidth={false}
                  wrap
                  size="small"
                  className="w-full"
                />
              ) : undefined,
          }}
          emptyTitle={
            scriptSearch || activeCategory !== "all"
              ? t("common:status.noResults")
              : t("launchpad.detail.noScripts")
          }
          addFooter={
            showAddScript
              ? undefined
              : {
                  label: t("launchpad.detail.addScript"),
                  onClick: () => setShowAddScript(true),
                }
          }
        />

        {showAddScript && (
          <div className="mt-3">
            <AddScriptRow onAdd={addScript} />
          </div>
        )}
      </CollapsibleSection>
    </div>
  );
};

export default RepoDetailPage;
