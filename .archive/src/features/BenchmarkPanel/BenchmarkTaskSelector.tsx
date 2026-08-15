import {
  ChevronDown,
  ChevronRight,
  ListChevronsDownUp,
  ListChevronsUpDown,
  Search,
} from "lucide-react";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { BenchmarkTaskIndexRow } from "@src/api/tauri/benchmark";
import Button from "@src/components/Button";
import Checkbox from "@src/components/Checkbox";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";

interface BenchmarkTaskSelectorProps {
  tasks: BenchmarkTaskIndexRow[];
  selectedTaskIds: string[];
  searchValue: string;
  collapsedGroups: ReadonlySet<string>;
  isLoading: boolean;
  canLoadTasks: boolean;
  error?: string | null;
  className?: string;
  onSearchChange: (value: string) => void;
  onToggleTask: (taskId: string, checked: boolean) => void;
  onSelectAllVisible: (checked: boolean, taskIds: string[]) => void;
  onSelectGroup: (taskIds: string[], checked: boolean) => void;
  onToggleGroup: (repo: string) => void;
  onToggleAllGroups: (repos: string[]) => void;
}

export const BenchmarkTaskSelector: React.FC<BenchmarkTaskSelectorProps> = ({
  tasks,
  selectedTaskIds,
  searchValue,
  collapsedGroups,
  isLoading,
  canLoadTasks,
  error,
  className,
  onSearchChange,
  onToggleTask,
  onSelectAllVisible,
  onSelectGroup,
  onToggleGroup,
  onToggleAllGroups,
}) => {
  const { t } = useTranslation(["sessions", "common"]);
  const normalizedSearch = searchValue.trim().toLowerCase();
  const taskGroups = useMemo(() => {
    const groups = new Map<string, BenchmarkTaskIndexRow[]>();
    for (const task of tasks) {
      const groupKey = task.repo ?? t("creator.benchmark.unknownRepo");
      const searchableText =
        `${task.taskId} ${task.title} ${task.repo ?? ""}`.toLowerCase();
      if (normalizedSearch && !searchableText.includes(normalizedSearch)) {
        continue;
      }
      const existing = groups.get(groupKey) ?? [];
      existing.push(task);
      groups.set(groupKey, existing);
    }
    return Array.from(groups.entries()).map(([repo, groupTasks]) => ({
      repo,
      tasks: groupTasks,
    }));
  }, [normalizedSearch, tasks, t]);

  const visibleTaskIds = useMemo(
    () => taskGroups.flatMap((group) => group.tasks.map((task) => task.taskId)),
    [taskGroups]
  );
  const allVisibleTasksSelected =
    visibleTaskIds.length > 0 &&
    visibleTaskIds.every((taskId) => selectedTaskIds.includes(taskId));
  const someVisibleTasksSelected = visibleTaskIds.some((taskId) =>
    selectedTaskIds.includes(taskId)
  );
  const allGroupsCollapsed =
    taskGroups.length > 0 &&
    taskGroups.every((group) => collapsedGroups.has(group.repo));

  return (
    <div className={`${className ?? ""} flex flex-col gap-2`}>
      <div className="flex items-center gap-2">
        <div className="shrink-0 text-[13px] font-semibold text-text-1">
          {t("creator.benchmark.taskSelectionTitle")}
        </div>
        <div className="text-[13px] text-text-2">
          {t("creator.benchmark.selectedTasks", {
            selected: selectedTaskIds.length,
            total: tasks.length,
          })}
        </div>
        <div className="flex flex-1 items-center justify-end">
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            icon={
              allGroupsCollapsed ? (
                <ListChevronsUpDown size={14} strokeWidth={1.75} />
              ) : (
                <ListChevronsDownUp size={14} strokeWidth={1.75} />
              )
            }
            title={
              allGroupsCollapsed
                ? t("common:actions.expandAll")
                : t("common:actions.collapseAll")
            }
            aria-label={
              allGroupsCollapsed
                ? t("common:actions.expandAll")
                : t("common:actions.collapseAll")
            }
            onClick={() =>
              onToggleAllGroups(taskGroups.map((group) => group.repo))
            }
            disabled={taskGroups.length === 0}
          />
          <div className="mx-2 h-4 w-px bg-border-2" />
          <Checkbox
            checked={allVisibleTasksSelected}
            indeterminate={!allVisibleTasksSelected && someVisibleTasksSelected}
            disabled={isLoading || tasks.length === 0}
            size="small"
            onChange={(checked) => onSelectAllVisible(checked, visibleTaskIds)}
          >
            {t("common:actions.selectAll")}
          </Checkbox>
        </div>
      </div>
      <Input
        value={searchValue}
        onChange={onSearchChange}
        placeholder={t("creator.benchmark.searchPlaceholder")}
        prefix={<Search size={14} />}
        allowClear
        size="small"
      />
      <div className="scrollbar-overlay flex max-h-64 flex-col gap-2 overflow-y-auto py-1">
        {taskGroups.map((group) => {
          const groupTaskIds = group.tasks.map((task) => task.taskId);
          const allGroupTasksSelected = groupTaskIds.every((taskId) =>
            selectedTaskIds.includes(taskId)
          );
          const someGroupTasksSelected = groupTaskIds.some((taskId) =>
            selectedTaskIds.includes(taskId)
          );
          const isCollapsed = collapsedGroups.has(group.repo);
          return (
            <div key={group.repo} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 rounded-md px-2 py-1">
                <button
                  type="button"
                  className="flex h-4 w-4 shrink-0 items-center justify-center text-text-3 hover:text-text-1"
                  onClick={() => onToggleGroup(group.repo)}
                  aria-label={
                    isCollapsed
                      ? t("common:actions.expand")
                      : t("common:actions.collapse")
                  }
                >
                  {isCollapsed ? (
                    <ChevronRight size={14} className="shrink-0" />
                  ) : (
                    <ChevronDown size={14} className="shrink-0" />
                  )}
                </button>
                <Checkbox
                  checked={allGroupTasksSelected}
                  indeterminate={
                    !allGroupTasksSelected && someGroupTasksSelected
                  }
                  disabled={isLoading || groupTaskIds.length === 0}
                  size="small"
                  onChange={(checked) => onSelectGroup(groupTaskIds, checked)}
                  ariaLabel={t("common:actions.selectAll")}
                />
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  onClick={() => onToggleGroup(group.repo)}
                >
                  <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-text-3">
                    {group.repo}
                  </span>
                  <span className="shrink-0 text-[11px] text-text-3">
                    {group.tasks.length}
                  </span>
                </button>
              </div>
              {!isCollapsed ? (
                <div className="flex flex-col divide-y divide-border-2">
                  {group.tasks.map((task) => {
                    const checked = selectedTaskIds.includes(task.taskId);
                    return (
                      <div
                        key={task.taskId}
                        className="flex cursor-pointer items-center gap-2 py-1.5 pl-8 pr-2"
                        onClick={() => {
                          if (!isLoading && canLoadTasks) {
                            onToggleTask(task.taskId, !checked);
                          }
                        }}
                      >
                        <Checkbox
                          checked={checked}
                          disabled={isLoading || !canLoadTasks}
                          size="small"
                          onClick={(event) => event.stopPropagation()}
                          onChange={(nextChecked) =>
                            onToggleTask(task.taskId, nextChecked)
                          }
                          ariaLabel={task.taskId}
                        />
                        <span className="min-w-0 flex-1 truncate text-left text-[12px] text-text-1">
                          {task.taskId}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {!canLoadTasks ? (
        <p className="m-0 text-[12px] leading-5 text-text-3">
          {t("creator.benchmark.taskLoadingUnsupported")}
        </p>
      ) : error ? (
        <InlineAlert
          type="danger"
          title={t("common:errors.failedToLoad")}
          className="!py-2"
        >
          <p className="m-0 break-words text-[12px] leading-5">{error}</p>
        </InlineAlert>
      ) : !isLoading && tasks.length === 0 ? (
        <p className="m-0 text-[12px] leading-5 text-text-3">
          {t("creator.benchmark.emptyTasks")}
        </p>
      ) : null}
    </div>
  );
};

export default BenchmarkTaskSelector;
