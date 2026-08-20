/**
 * Dependencies Table
 *
 * Shows installation status for system dependencies (package managers,
 * runtimes, toolchains, etc.). Category pills shown by default (single-select).
 */
import TabPill from "@/src/components/TabPill";
import type { TabPillItem } from "@/src/components/TabPill";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import type { DependencyStatus } from "@src/modules/MainApp/Integrations/hooks/useSystemDependencies";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { InfoRow } from "@src/modules/shared/layouts/blocks/InfoRow";

import {
  InlineCardBody,
  InlineCardColumnStack,
  InlineCardSectionLabel,
  InlineCardShell,
  InlineCardSplit,
} from "../../../KeyVault/shared/InlineCardPrimitives";
import { StatusDot, selectedRowClassName } from "../../../Tables/shared";
import { InstallScriptPanel } from "../../../shared/InstallScriptPanel";

const DEFAULT_CATEGORY_KEY = "package-manager";

const CATEGORY_LABEL_KEYS: Record<string, string> = {
  "package-manager": "dependencies.categoryPackageManager",
  runtime: "dependencies.categoryRuntime",
  "version-control": "dependencies.categoryVersionControl",
  toolchain: "dependencies.categoryToolchain",
  "shell-utility": "dependencies.categoryShellUtility",
  database: "dependencies.categoryDatabase",
};

interface DependenciesTableProps {
  dependencies: DependencyStatus[];
  loading: boolean;
  selectedDepId?: string | null;
  onSelectDep?: (dep: DependencyStatus | null) => void;
}

const DependenciesTable: React.FC<DependenciesTableProps> = ({
  dependencies,
  loading,
  selectedDepId,
  onSelectDep,
}) => {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] =
    useState<string>(DEFAULT_CATEGORY_KEY);
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);

  const categoryTabs = useMemo<TabPillItem[]>(() => {
    const categories = new Set<string>();
    dependencies.forEach((dep) => categories.add(dep.category));
    const sorted = Array.from(categories).sort();
    const ordered = sorted.includes(DEFAULT_CATEGORY_KEY)
      ? [
          DEFAULT_CATEGORY_KEY,
          ...sorted.filter((cat) => cat !== DEFAULT_CATEGORY_KEY),
        ]
      : sorted;
    return ordered.map((cat) => ({
      key: cat,
      label: CATEGORY_LABEL_KEYS[cat] ? t(CATEGORY_LABEL_KEYS[cat]) : cat,
    }));
  }, [dependencies, t]);

  const activeCategory = categoryTabs.some(
    (tab) => tab.key === selectedCategory
  )
    ? selectedCategory
    : (categoryTabs[0]?.key ?? DEFAULT_CATEGORY_KEY);

  const filteredDeps = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();

    return dependencies
      .filter((dep) => {
        if (dep.category !== activeCategory) {
          return false;
        }
        if (!query) return true;
        return (
          dep.name.toLowerCase().includes(query) ||
          dep.binary.toLowerCase().includes(query) ||
          dep.category.toLowerCase().includes(query)
        );
      })
      .sort((depA, depB) => {
        if (depA.installed !== depB.installed) {
          return depA.installed ? -1 : 1;
        }
        return depA.name.localeCompare(depB.name);
      });
  }, [dependencies, searchQuery, activeCategory]);

  const handleCategoryChange = useCallback((key: string) => {
    setSelectedCategory(key);
  }, []);

  const columns = useMemo<SettingsTableColumn<DependencyStatus>[]>(
    () => [
      {
        key: "name",
        label: t("dependencies.tableName"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (depA, depB) => depA.name.localeCompare(depB.name),
        renderCell: (dep) => (
          <span className={`${SETTINGS_TABLE_CELL.primary} font-bold`}>
            {dep.name}
          </span>
        ),
      },
      {
        key: "category",
        label: t("dependencies.tableCategory"),
        width: SETTINGS_TABLE_COL.valueMd,
        sorter: (depA, depB) => depA.category.localeCompare(depB.category),
        renderCell: (dep) => (
          <span className={`${SETTINGS_TABLE_CELL.muted} whitespace-nowrap`}>
            {CATEGORY_LABEL_KEYS[dep.category]
              ? t(CATEGORY_LABEL_KEYS[dep.category])
              : dep.category}
          </span>
        ),
      },
      {
        key: "version",
        label: t("dependencies.tableVersion"),
        width: SETTINGS_TABLE_COL.valueMd,
        renderCell: (dep) =>
          dep.installed && dep.version ? (
            <span className={`${SETTINGS_TABLE_CELL.muted} whitespace-nowrap`}>
              {dep.version}
            </span>
          ) : null,
      },
      {
        key: "status",
        label: t("dependencies.tableStatus"),
        width: SETTINGS_TABLE_COL.valueMd,
        sorter: (depA, depB) => Number(depB.installed) - Number(depA.installed),
        renderCell: (dep) => (
          <StatusDot
            color={dep.installed ? "bg-success-6" : "bg-fill-3"}
            label={
              dep.installed
                ? t("dependencies.installed")
                : t("dependencies.notFound")
            }
          />
        ),
      },
    ],
    [t]
  );

  if (loading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center rounded-lg bg-fill-2">
        <Placeholder variant="loading" />
      </div>
    );
  }

  return (
    <SettingsTable<DependencyStatus>
      hover
      searchBar={{
        searchValue: searchQuery,
        onSearchChange: setSearchQuery,
        searchPlaceholder: tCommon("common.searchPlaceholder"),
        allowSearchClear: true,
        tabPills: (
          <TabPill
            tabs={categoryTabs}
            activeTab={activeCategory}
            onChange={handleCategoryChange}
            variant="pill"
            appearance="ghost"
            fillWidth={false}
            wrap
            size="mini"
            className="w-full"
          />
        ),
      }}
      columns={columns}
      rows={filteredDeps}
      getRowKey={(dep) => dep.binary}
      onRowClick={
        onSelectDep
          ? (dep) => {
              onSelectDep(selectedDepId === dep.binary ? null : dep);
            }
          : undefined
      }
      rowClassName={selectedRowClassName(
        (dep: DependencyStatus) => dep.binary,
        selectedDepId
      )}
      headerHeight="tall"
      emptyTitle={t("dependencies.noDepsFound")}
      emptySubtitle={
        searchQuery ? t("dependencies.tryAdjustFilters") : undefined
      }
      expandable={{
        expandedRowKeys: expandedKeys,
        onExpandedRowsChange: (keys) => setExpandedKeys(keys.slice(-1)),
        expandedRowRender: (dep) => {
          const categoryLabel = CATEGORY_LABEL_KEYS[dep.category]
            ? t(CATEGORY_LABEL_KEYS[dep.category])
            : dep.category;
          const installHint = dep.installHint?.trim();
          const showInstallHint = !dep.installed && !!installHint;
          return (
            <div className="w-0 min-w-full overflow-hidden">
              <InlineCardShell>
                <InlineCardBody>
                  <InlineCardSplit
                    left={
                      <InlineCardColumnStack>
                        <InfoRow label={t("dependencies.tableStatus")}>
                          <span
                            className={`text-[12px] font-medium ${dep.installed ? "text-success-6" : "text-text-3"}`}
                          >
                            {dep.installed
                              ? t("dependencies.installed")
                              : t("dependencies.notFound")}
                          </span>
                        </InfoRow>
                        <InfoRow label={t("dependencies.tableCategory")}>
                          <span className="text-[12px] text-text-2">
                            {categoryLabel}
                          </span>
                        </InfoRow>
                        {dep.installed && dep.version && (
                          <InfoRow label={t("dependencies.tableVersion")}>
                            <span className="text-[12px] font-medium text-text-1">
                              {dep.version}
                            </span>
                          </InfoRow>
                        )}
                        <InfoRow label={t("dependencies.tableBinary")}>
                          <span className="text-[12px] text-text-2">
                            {dep.binary}
                          </span>
                        </InfoRow>
                      </InlineCardColumnStack>
                    }
                    right={
                      showInstallHint && installHint ? (
                        <InlineCardColumnStack>
                          <InlineCardSectionLabel>
                            {t("dependencies.installSection")}
                          </InlineCardSectionLabel>
                          <p className="text-[12px] text-text-2">
                            {t("dependencies.installHintNote")}
                          </p>
                          <InstallScriptPanel
                            mode="install"
                            command={installHint}
                          />
                        </InlineCardColumnStack>
                      ) : (
                        <InlineCardColumnStack>{null}</InlineCardColumnStack>
                      )
                    }
                  />
                </InlineCardBody>
              </InlineCardShell>
            </div>
          );
        },
      }}
    />
  );
};

export default DependenciesTable;
