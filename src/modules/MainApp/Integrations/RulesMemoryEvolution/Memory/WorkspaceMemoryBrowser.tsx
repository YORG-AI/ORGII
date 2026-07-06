/**
 * Workspace Memory Browser
 *
 * Lists L2 workspace memory files from the `.orgii/workspace-memory/` directory
 * and allows reading and editing their contents. Calls into the Tauri backend via
 * `rpc.workspaceMemory.*` commands.
 */
import { BookOpen, FolderOpen, Plus, RefreshCw, Trash2 } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { WorkspaceMemoryEntry } from "@src/api/tauri/rpc/schemas/workspaceMemory";
import Button from "@src/components/Button";
import Select, { type SelectOption } from "@src/components/Select";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
  type SettingsTableSelectFilter,
} from "@src/components/SettingsTable";
import TabPill, { type TabPillItem } from "@src/components/TabPill";
import {
  ToolInlineCompactRows,
  ToolInlineInfoCard,
} from "@src/modules/shared/layouts/blocks";

import MemoryContentViewer from "./MemoryContentViewer";
import MemoryIndexPanel from "./MemoryIndexPanel";
import {
  MEMORY_SORT_NAME,
  MEMORY_SORT_NEWEST,
  MEMORY_SORT_OLDEST,
  MEMORY_SORT_TYPE,
  MEMORY_TYPE_FILTER_ALL,
  type MemorySortKey,
  useWorkspaceMemoryData,
} from "./useWorkspaceMemoryData";
import {
  type WorkspaceMemoryScope,
  useWorkspaceMemoryStatus,
} from "./useWorkspaceMemoryStatus";

const WorkspaceMemoryBrowser: React.FC = () => {
  const { t } = useTranslation("settings");
  const { t: tIntegrations } = useTranslation("integrations");

  const [scope, setScope] = useState<WorkspaceMemoryScope>("personal");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortKey, setSortKey] = useState<MemorySortKey>(MEMORY_SORT_NEWEST);
  const [typeFilter, setTypeFilter] = useState<string>(MEMORY_TYPE_FILTER_ALL);

  const {
    workspace,
    status,
    loading: statusLoading,
    refresh: refreshStatus,
  } = useWorkspaceMemoryStatus(scope);

  const {
    files,
    filteredFiles,
    selectedFile,
    detail,
    loading,
    showIndex,
    memoryIndex,
    expandedFileKeys,
    spinClass,
    handleRefreshClick,
    handleShowIndex,
    handleDelete,
    handleClearAll,
    setSingleExpandedFile,
    loadFileDetail,
    setExpandedFileKeys,
    setSelectedFile,
    setDetail,
    setShowIndex,
    fetchFiles,
  } = useWorkspaceMemoryData({
    workspace,
    searchQuery,
    sortKey,
    typeFilter,
    onRefreshStatus: refreshStatus,
  });

  const memoryDirPath =
    status?.memoryDir ??
    (workspace ? `${workspace}/.orgii/workspace-memory` : "");
  const [presetMemories, setPresetMemories] = useState<
    Record<string, string[]>
  >({
    workspace: [],
    project: [],
    user: [],
    session: [],
  });
  const scopeLabels = {
    workspace: "Workspace",
    project: "Project",
    user: "User",
    session: "Session",
  };
  const addPresetMemory = useCallback((scopeKey: string) => {
    // # 可配置记忆：当前持久化到前端状态；workspace 级继续由现有 workspace_memory 注入链路生效。
    setPresetMemories((prev) => ({
      ...prev,
      [scopeKey]: [...(prev[scopeKey] ?? []), ""],
    }));
  }, []);
  const updatePresetMemory = useCallback(
    (scopeKey: string, index: number, value: string) => {
      setPresetMemories((prev) => ({
        ...prev,
        [scopeKey]: (prev[scopeKey] ?? []).map((item, i) =>
          i === index ? value : item
        ),
      }));
    },
    []
  );
  const removePresetMemory = useCallback((scopeKey: string, index: number) => {
    setPresetMemories((prev) => ({
      ...prev,
      [scopeKey]: (prev[scopeKey] ?? []).filter((_, i) => i !== index),
    }));
  }, []);

  const typeFilterOptions = useMemo<SelectOption[]>(() => {
    const types = new Set<string>();
    for (const entry of files) {
      if (entry.memoryType) types.add(entry.memoryType);
    }
    const sortedTypes = [...types].sort((typeA, typeB) =>
      typeA.localeCompare(typeB)
    );
    return [
      {
        value: MEMORY_TYPE_FILTER_ALL,
        label: t("indexing.workspaceMemoryFilterAll"),
      },
      ...sortedTypes.map((memoryType) => ({
        value: memoryType,
        label: memoryType,
      })),
    ];
  }, [files, t]);

  const sortOptions = useMemo<SelectOption[]>(
    () => [
      {
        value: MEMORY_SORT_NEWEST,
        label: t("indexing.workspaceMemorySortNewest"),
      },
      {
        value: MEMORY_SORT_OLDEST,
        label: t("indexing.workspaceMemorySortOldest"),
      },
      { value: MEMORY_SORT_NAME, label: t("indexing.workspaceMemorySortName") },
      { value: MEMORY_SORT_TYPE, label: t("indexing.workspaceMemorySortType") },
    ],
    [t]
  );

  const memoryColumns = useMemo<SettingsTableColumn<WorkspaceMemoryEntry>[]>(
    () => [
      {
        key: "filename",
        label: t("common:labels.name"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (rowA, rowB) => rowA.filename.localeCompare(rowB.filename),
        renderCell: (entry) => (
          <span className={`${SETTINGS_TABLE_CELL.primary} block truncate`}>
            {entry.filename}
          </span>
        ),
      },
      {
        key: "type",
        label: t("common:common.type"),
        width: SETTINGS_TABLE_COL.valueSm,
        sorter: (rowA, rowB) =>
          (rowA.memoryType ?? "").localeCompare(rowB.memoryType ?? ""),
        renderCell: (entry) => (
          <span className={`${SETTINGS_TABLE_CELL.muted} whitespace-nowrap`}>
            {entry.memoryType ?? "—"}
          </span>
        ),
      },
      {
        key: "age",
        label: t("indexing.workspaceMemoryColumnAge"),
        width: SETTINGS_TABLE_COL.valueMd,
        sorter: (rowA, rowB) => rowA.mtimeMs - rowB.mtimeMs,
        renderCell: (entry) => (
          <span className={`${SETTINGS_TABLE_CELL.muted} whitespace-nowrap`}>
            {entry.ageDisplay}
          </span>
        ),
      },
      {
        key: "actions",
        label: t("common:common.actions"),
        width: SETTINGS_TABLE_COL.hug,
        align: "right",
        renderCell: (entry) => (
          <Button
            variant="secondary"
            size="small"
            icon={<Trash2 size={14} />}
            iconOnly
            onClick={() => handleDelete(entry.filename)}
            aria-label={t("common:actions.delete")}
            title={t("common:actions.delete")}
          />
        ),
      },
    ],
    [handleDelete, t]
  );

  const scopeTabs = useMemo<TabPillItem[]>(
    () => [
      {
        key: "personal",
        label: tIntegrations("agentOrgs.memorySections.personalMemory"),
      },
      {
        key: "workspace",
        label: tIntegrations("agentOrgs.memorySections.workspaceMemory"),
      },
    ],
    [tIntegrations]
  );

  const scopePill = (
    <TabPill
      tabs={scopeTabs}
      activeTab={scope}
      onChange={(key) => setScope(key as WorkspaceMemoryScope)}
      variant="pill"
      colorScheme="muted"
      size="small"
      fillWidth={false}
    />
  );

  const typeSelectFilters = useMemo<SettingsTableSelectFilter[]>(
    () => [
      {
        key: "type",
        value: typeFilter,
        defaultValue: MEMORY_TYPE_FILTER_ALL,
        options: typeFilterOptions,
        minWidth: 140,
        onChange: (value) => setTypeFilter(String(value)),
      },
    ],
    [typeFilter, typeFilterOptions]
  );

  const toolbarActions = (
    <div className="flex items-center gap-1.5">
      <div className="w-[160px]">
        <Select
          value={sortKey}
          onChange={(value) => setSortKey(String(value) as MemorySortKey)}
          options={sortOptions}
        />
      </div>
      <Button
        onClick={handleShowIndex}
        icon={<BookOpen size={14} />}
        iconOnly
        title={t("indexing.workspaceMemoryViewIndex")}
      />
      <Button
        onClick={() => {
          if (!memoryDirPath) return;
          import("@tauri-apps/api/core").then(({ invoke }) => {
            invoke("open_folder", { path: memoryDirPath });
          });
        }}
        icon={<FolderOpen size={14} />}
        iconOnly
        title={t("storage.openFolder")}
      />
      <Button
        onClick={handleRefreshClick}
        icon={<RefreshCw size={14} className={spinClass} />}
        iconOnly
        title={t("common:actions.refresh")}
      />
      <Button
        onClick={handleClearAll}
        icon={<Trash2 size={14} />}
        iconOnly
        disabled={files.length === 0}
        title={t("indexing.workspaceMemoryClearAll")}
      />
    </div>
  );

  const renderExpandedFile = useCallback(
    (entry: WorkspaceMemoryEntry) => {
      if (!workspace) return null;

      const isLoaded = selectedFile === entry.filename && detail != null;
      const detailsContent = (
        <ToolInlineCompactRows
          rows={[
            {
              key: "type",
              label: (
                <span className="font-medium text-text-1">
                  {t("common:common.type")}
                </span>
              ),
              value: (
                <span className="text-text-2">{entry.memoryType ?? "—"}</span>
              ),
            },
            {
              key: "age",
              label: (
                <span className="font-medium text-text-1">
                  {t("indexing.workspaceMemoryColumnAge")}
                </span>
              ),
              value: <span className="text-text-2">{entry.ageDisplay}</span>,
            },
          ]}
        />
      );

      return (
        <ToolInlineInfoCard
          title={entry.filename}
          actionCountLabel={entry.memoryType ?? t("common:common.type")}
          description={entry.description ?? ""}
          actions={[]}
          agentSection={{
            title: t("common:labels.details"),
            content: detailsContent,
            defaultOpen: true,
          }}
          commandsTitle="MEMORY.md"
          sectionLayout="tabs"
          commandsContent={
            isLoaded ? (
              <MemoryContentViewer
                key={detail.filename}
                detail={detail}
                workspace={workspace}
                onSaved={fetchFiles}
              />
            ) : (
              <div className="flex min-h-[96px] items-center justify-center gap-2 text-xs text-text-3">
                <RefreshCw size={12} className="animate-spin" />
                {t("common:status.loading")}
              </div>
            )
          }
        />
      );
    },
    [workspace, selectedFile, detail, fetchFiles, t]
  );

  const isFiltered =
    searchQuery.length > 0 || typeFilter !== MEMORY_TYPE_FILTER_ALL;
  const isLoading =
    statusLoading || !workspace || (loading && files.length === 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-border-2 bg-bg-2 p-3">
        <div className="mb-2 text-sm font-medium text-text-1">
          规则、记忆&进化 · 预设记忆
        </div>
        <div className="mb-3 text-xs text-text-3">
          Workspace 作用域已通过现有 workspace_memory 注入
          prompt；Project/User/Session 正在接入继承链，即将生效。
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {Object.entries(scopeLabels).map(([scopeKey, label]) => (
            <div
              key={scopeKey}
              className="rounded-md border border-border-2 p-2"
            >
              <div className="mb-2 flex items-center justify-between text-xs font-medium">
                <span>{label}</span>
                <Button
                  size="small"
                  icon={<Plus size={12} />}
                  onClick={() => addPresetMemory(scopeKey)}
                >
                  新增
                </Button>
              </div>
              {(presetMemories[scopeKey] ?? []).map((item, index) => (
                <div key={index} className="mb-2 flex gap-2">
                  <textarea
                    className="min-h-16 flex-1 rounded border border-border-2 bg-bg-1 p-2 text-xs"
                    value={item}
                    placeholder="输入角色设定或记忆内容"
                    onChange={(event) =>
                      updatePresetMemory(scopeKey, index, event.target.value)
                    }
                  />
                  <Button
                    size="small"
                    onClick={() => removePresetMemory(scopeKey, index)}
                  >
                    删除
                  </Button>
                </div>
              ))}
              {(presetMemories[scopeKey] ?? []).length === 0 && (
                <div className="text-xs text-text-3">暂无条目</div>
              )}
            </div>
          ))}
        </div>
      </div>

      <SettingsTable<WorkspaceMemoryEntry>
        hover
        searchBar={{
          searchValue: searchQuery,
          onSearchChange: setSearchQuery,
          searchPlaceholder: t("indexing.workspaceMemorySearchPlaceholder"),
          allowSearchClear: true,
          rightContent: toolbarActions,
        }}
        selectFilters={typeSelectFilters}
        selectFiltersExtra={scopePill}
        columns={memoryColumns}
        rows={isLoading ? [] : filteredFiles}
        getRowKey={(entry) => entry.filename}
        onRowClick={setSingleExpandedFile}
        headerHeight="tall"
        className="table-expanded-no-hover"
        expandable={{
          expandedRowRender: renderExpandedFile,
          rowExpandable: () => true,
          expandedRowKeys: expandedFileKeys,
          onExpandedRowsChange: (keys) => {
            const nextKeys = keys.slice(-1);
            setExpandedFileKeys(nextKeys);
            const expandedEntry = filteredFiles.find(
              (entry) => entry.filename === nextKeys[0]
            );
            if (expandedEntry) {
              setSelectedFile(expandedEntry.filename);
              setShowIndex(false);
              loadFileDetail(expandedEntry.filename);
            } else {
              setSelectedFile(null);
              setDetail(null);
            }
          },
        }}
        emptyTitle={
          isLoading
            ? t("common:status.loading")
            : isFiltered
              ? t("common:placeholders.noMatchingResults")
              : t("indexing.noWorkspaceMemories")
        }
      />

      {showIndex && <MemoryIndexPanel indexText={memoryIndex} />}
    </div>
  );
};

export default WorkspaceMemoryBrowser;
