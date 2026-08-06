/**
 * Workspace Memory Browser
 *
 * Lists L2 workspace memory files from the `.orgii/workspace-memory/` directory
 * and allows reading and editing their contents. Calls into the Tauri backend via
 * `rpc.workspaceMemory.*` commands.
 */
import { ask } from "@tauri-apps/plugin-dialog";
import { BookOpen, FolderOpen, Plus, RefreshCw, Trash2 } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import type { GlobalPathExemption } from "@src/api/tauri/rpc/schemas/globalPathExemptions";
import type { WorkspaceMemoryEntry } from "@src/api/tauri/rpc/schemas/workspaceMemory";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
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
import { globalPathExemptionErrorMessage } from "./globalPathExemptionError";
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

  const [globalExemptions, setGlobalExemptions] = useState<
    GlobalPathExemption[]
  >([]);
  const [globalPath, setGlobalPath] = useState("");
  const [globalLoading, setGlobalLoading] = useState(true);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [globalRefreshing, setGlobalRefreshing] = useState(false);

  const loadGlobalExemptions = useCallback((refresh = false) => {
    if (refresh) setGlobalRefreshing(true);
    else setGlobalLoading(true);
    setGlobalError(null);
    rpc.globalPathExemptions
      .list()
      .then(setGlobalExemptions)
      .catch((error: unknown) =>
        setGlobalError(globalPathExemptionErrorMessage(error))
      )
      .finally(() => {
        setGlobalLoading(false);
        setGlobalRefreshing(false);
      });
  }, []);

  useEffect(() => loadGlobalExemptions(), [loadGlobalExemptions]);

  const addGlobalExemption = useCallback(() => {
    const rawPath = globalPath;
    if (!rawPath.trim()) return;
    void ask(
      `你正在授予所有 Session 对以下目录及其子目录的 workspace 外访问权限：\n\n“${rawPath}”\n\n该授权是递归且全局的。不会绕过系统文件权限、禁止路径、只读 Agent、命令审批或第三方 CLI 自身沙箱。`,
      { kind: "warning" }
    ).then((confirmed) => {
      if (!confirmed) return;
      rpc.globalPathExemptions
        .add({ path: rawPath })
        .then((entry) => {
          setGlobalPath("");
          setGlobalExemptions((current) => [
            ...current.filter((item) => item.id !== entry.id),
            entry,
          ]);
          Message.success("全局路径权限豁免已添加。");
        })
        .catch((error: unknown) =>
          Message.error(globalPathExemptionErrorMessage(error))
        );
    });
  }, [globalPath]);

  const removeGlobalExemption = useCallback(
    (id: string, path: string) => {
      void ask(
        `确定移除“${path}”的全局路径权限豁免吗？\n\n这只会移除权限记录，不会删除实际目录。Native sessions 会在下一次工具调用时生效；已有外部 CLI 可能要到下次启动才反映。`,
        { kind: "warning" }
      ).then((confirmed) => {
        if (!confirmed) return;
        rpc.globalPathExemptions
          .remove({ id })
          .then(() => loadGlobalExemptions(true))
          .catch((error: unknown) =>
            Message.error(globalPathExemptionErrorMessage(error))
          );
      });
    },
    [loadGlobalExemptions]
  );

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

      <section
        className="border-y border-border-2 py-3"
        aria-label="全局路径权限豁免"
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-text-1">
              全局路径权限豁免{" "}
              <span className="text-text-3">Global path exemptions</span>
            </h3>
            <p className="mt-1 text-xs text-text-3">
              这是全局安全状态，不属于预设记忆或 Memory scope。它只允许 Native
              sessions 访问 workspace 外的已授权目录。
            </p>
          </div>
          <Button
            icon={
              <RefreshCw
                size={14}
                className={globalRefreshing ? "animate-spin" : undefined}
              />
            }
            iconOnly
            onClick={() => loadGlobalExemptions(true)}
            disabled={globalLoading || globalRefreshing}
            title="刷新全局路径权限豁免"
            aria-label="刷新全局路径权限豁免"
          />
        </div>
        <p className="mb-3 text-xs text-text-3">
          不会绕过系统文件权限、禁止路径、只读 Agent、命令审批、dotenv secret
          guard 或第三方 CLI 自身沙箱。未来 Claude Code/Codex 启动会收到{" "}
          <code>--add-dir</code>；Cursor 和不支持的 CLI 无法保证支持。
        </p>
        <div className="mb-3 flex gap-2">
          <Input
            value={globalPath}
            onChange={setGlobalPath}
            placeholder="输入要授权的绝对目录路径"
            aria-label="全局路径权限豁免目录"
            className="flex-1"
          />
          <Button
            onClick={addGlobalExemption}
            disabled={!globalPath.trim()}
            icon={<Plus size={14} />}
          >
            Add
          </Button>
        </div>
        {globalError && (
          <p className="text-error mb-2 text-xs">{globalError}</p>
        )}
        {globalLoading ? (
          <div className="flex min-h-[56px] items-center gap-2 text-xs text-text-3">
            <RefreshCw size={12} className="animate-spin" />
            {t("common:status.loading")}
          </div>
        ) : globalExemptions.length === 0 ? (
          <p className="text-xs text-text-3">暂无全局路径权限豁免。</p>
        ) : (
          <div className="divide-y divide-border-2 border-y border-border-2">
            {globalExemptions.map((entry) => (
              <div
                key={entry.id}
                className="flex items-start justify-between gap-3 py-2"
              >
                <div className="min-w-0 text-xs">
                  <div
                    className="truncate font-medium text-text-1"
                    title={entry.canonicalPath}
                  >
                    {entry.canonicalPath}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-text-3">
                    <span>Global</span>
                    <span>Read &amp; write</span>
                    <span>Native sessions</span>
                    <span>{new Date(entry.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="mt-1 text-text-3">
                    Native sessions 在下一次工具调用时更新；已有外部 CLI
                    可能要到下次启动才反映。
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="small"
                  icon={<Trash2 size={14} />}
                  iconOnly
                  onClick={() =>
                    removeGlobalExemption(entry.id, entry.canonicalPath)
                  }
                  aria-label={`移除 ${entry.canonicalPath} 的全局路径权限豁免`}
                  title="移除全局路径权限豁免"
                />
              </div>
            ))}
          </div>
        )}
      </section>

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
