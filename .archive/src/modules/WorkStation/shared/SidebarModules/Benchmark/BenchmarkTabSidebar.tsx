import { useAtom } from "jotai";
import { BookLock } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { BenchmarkTaskIndexRow } from "@src/api/tauri/benchmark";
import Input from "@src/components/Input";
import type { SectionHeaderAction } from "@src/components/TreePanelSidebar/types";
import { TreeRowBase, type TreeRowNode } from "@src/components/TreeRow";
import { useBenchmarkTasks } from "@src/features/BenchmarkPanel/hooks/useBenchmarkTasks";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  ICON_CONFIG,
  PANEL_CONSTANTS,
} from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/config";
import {
  PrimarySidebarLayoutWithSections,
  type PrimarySidebarTab,
} from "@src/modules/WorkStation/shared/PrimarySidebarLayout";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { benchmarkExpandedReposAtom } from "@src/store/benchmark";

import type { TabSidebarComponent } from "../registry";
import { registerTabSidebar } from "../registry";

const UNKNOWN_REPO_KEY = "__unknown_repo__";
const {
  collapseAll: CollapseAllIcon,
  filter: FilterIcon,
  refresh: RefreshIcon,
} = ICON_CONFIG;
const ACTION_ICON_SIZE = PANEL_CONSTANTS.ACTION_ICON_SIZE;
const ACTION_ICON_STROKE_WIDTH = PANEL_CONSTANTS.ACTION_ICON_STROKE;

interface BenchmarkRepoGroup {
  repo: string;
  tasks: BenchmarkTaskIndexRow[];
}

interface BenchmarkSidebarContentProps {
  filterText: string;
}

const BenchmarkSidebarContent = memo(
  ({ filterText }: BenchmarkSidebarContentProps) => {
    const { t } = useTranslation("sessions");
    const { error, isLoadingTasks, selectedTaskId, setSelectedTaskId, tasks } =
      useBenchmarkTasks({ loadDetail: false });
    const [expandedRepos, setExpandedRepos] = useAtom(
      benchmarkExpandedReposAtom
    );

    const groupedTasks = useMemo<BenchmarkRepoGroup[]>(() => {
      const query = filterText.trim().toLowerCase();
      const groups = new Map<string, BenchmarkTaskIndexRow[]>();

      for (const task of tasks) {
        const repo = task.repo?.trim() || UNKNOWN_REPO_KEY;
        const searchableText = [task.taskId, task.title, task.repo]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        if (query && !searchableText.includes(query)) continue;

        const groupTasks = groups.get(repo) ?? [];
        groupTasks.push(task);
        groups.set(repo, groupTasks);
      }

      return Array.from(groups.entries())
        .sort(([leftRepo], [rightRepo]) => leftRepo.localeCompare(rightRepo))
        .map(([repo, groupTasks]) => ({ repo, tasks: groupTasks }));
    }, [filterText, tasks]);

    const handleToggleRepo = useCallback(
      (repo: string) => {
        setExpandedRepos((current) => ({
          ...current,
          [repo]: !(current[repo] ?? true),
        }));
      },
      [setExpandedRepos]
    );

    if (error) {
      return (
        <Placeholder
          variant="error"
          placement="sidebar"
          title={t("common:errors.failedToLoad")}
          subtitle={error}
          fillParentHeight
        />
      );
    }

    if (isLoadingTasks) {
      return (
        <Placeholder
          variant="loading"
          placement="sidebar"
          title={t("creator.benchmark.loading")}
          fillParentHeight
        />
      );
    }

    if (groupedTasks.length === 0) {
      return (
        <Placeholder
          variant="empty"
          placement="sidebar"
          title={t("creator.benchmark.emptyTasks")}
          fillParentHeight
        />
      );
    }

    return (
      <div className="scrollbar-overlay min-h-0 flex-1 overflow-y-auto py-1">
        {groupedTasks.map((group) => {
          const expanded = expandedRepos[group.repo] ?? true;
          const repoLabel =
            group.repo === UNKNOWN_REPO_KEY
              ? t("creator.benchmark.unknownRepo")
              : group.repo;
          const repoNode: TreeRowNode = {
            id: group.repo,
            name: repoLabel,
            path: group.repo,
            type: "directory",
            expanded,
          };

          return (
            <div key={group.repo} className="min-w-0">
              <TreeRowBase
                node={repoNode}
                depth={0}
                onClick={() => handleToggleRepo(group.repo)}
                showIndentGuides={false}
              >
                <span className="shrink-0 text-[11px] text-text-3">
                  {group.tasks.length}
                </span>
              </TreeRowBase>
              {expanded
                ? group.tasks.map((task) => {
                    const taskNode: TreeRowNode = {
                      id: task.taskId,
                      name: task.taskId,
                      path: task.taskId,
                      type: "file",
                      icon: (
                        <BookLock
                          size={ACTION_ICON_SIZE}
                          strokeWidth={ACTION_ICON_STROKE_WIDTH}
                          className="text-text-3"
                        />
                      ),
                    };
                    return (
                      <TreeRowBase
                        key={task.taskId}
                        node={taskNode}
                        depth={1}
                        isSelected={task.taskId === selectedTaskId}
                        onClick={() => setSelectedTaskId(task.taskId)}
                      />
                    );
                  })
                : null}
            </div>
          );
        })}
      </div>
    );
  }
);

BenchmarkSidebarContent.displayName = "BenchmarkSidebarContent";

const BenchmarkTabSidebar: TabSidebarComponent = memo(() => {
  const { t } = useTranslation("sessions");
  const { isLoadingTasks, loadTasks, tasks } = useBenchmarkTasks({
    loadDetail: false,
  });
  const [, setExpandedRepos] = useAtom(benchmarkExpandedReposAtom);
  const [showFilter, setShowFilter] = useState(false);
  const [filterText, setFilterText] = useState("");

  const repoKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const task of tasks) {
      keys.add(task.repo?.trim() || UNKNOWN_REPO_KEY);
    }
    return Array.from(keys);
  }, [tasks]);
  const hasTaskGroups = repoKeys.length > 0;

  const handleRefresh = useCallback(() => {
    void loadTasks();
  }, [loadTasks]);
  const { spinClass: refreshSpinClass, handleClick: handleRefreshClick } =
    useRefreshSpin(handleRefresh, isLoadingTasks);

  const handleCollapseAll = useCallback(() => {
    setExpandedRepos((current) => {
      const nextExpandedRepos = { ...current };
      for (const repoKey of repoKeys) {
        nextExpandedRepos[repoKey] = false;
      }
      return nextExpandedRepos;
    });
  }, [repoKeys, setExpandedRepos]);

  const actions = useMemo<SectionHeaderAction[]>(
    () => [
      {
        key: "filter-benchmark-tasks",
        icon: (
          <FilterIcon
            size={ACTION_ICON_SIZE}
            strokeWidth={ACTION_ICON_STROKE_WIDTH}
            className={showFilter ? "text-primary-6" : ""}
          />
        ),
        tooltip: t("creator.benchmark.searchPlaceholder"),
        onClick: () => setShowFilter((current) => !current),
        forceVisible: showFilter,
      },
      {
        key: "refresh-benchmark-tasks",
        icon: (
          <RefreshIcon
            className={refreshSpinClass}
            size={ACTION_ICON_SIZE}
            strokeWidth={ACTION_ICON_STROKE_WIDTH}
          />
        ),
        tooltip: t("creator.benchmark.loadTasks"),
        onClick: handleRefreshClick,
      },
      ...(hasTaskGroups
        ? [
            {
              key: "collapse-benchmark-repos",
              icon: (
                <CollapseAllIcon
                  size={ACTION_ICON_SIZE}
                  strokeWidth={ACTION_ICON_STROKE_WIDTH}
                />
              ),
              tooltip: t("common:tooltips.collapseAll"),
              onClick: handleCollapseAll,
            },
          ]
        : []),
    ],
    [
      handleCollapseAll,
      handleRefreshClick,
      hasTaskGroups,
      refreshSpinClass,
      showFilter,
      t,
    ]
  );

  const sectionContent = useMemo(
    () => (
      <div className="flex h-full min-h-0 flex-col">
        {showFilter ? (
          <div className="shrink-0 border-0 border-b border-solid border-border-1 px-2 py-1.5">
            <Input
              value={filterText}
              onChange={setFilterText}
              placeholder={t("creator.benchmark.searchPlaceholder")}
              size="small"
              appearance="bare"
              className="w-full"
              inputClassName="text-[12px]"
            />
          </div>
        ) : null}
        <BenchmarkSidebarContent filterText={filterText} />
      </div>
    ),
    [filterText, showFilter, t]
  );

  const tabs = useMemo<PrimarySidebarTab[]>(
    () => [
      {
        key: "benchmark",
        label: t("creator.benchmark.title"),
        icon: (
          <BookLock
            size={ACTION_ICON_SIZE}
            strokeWidth={ACTION_ICON_STROKE_WIDTH}
          />
        ),
        sections: [
          {
            key: "tasks",
            title: t("creator.benchmark.taskSelectionTitle"),
            content: sectionContent,
            actions,
            resizable: false,
          },
        ],
      },
    ],
    [actions, sectionContent, t]
  );

  return (
    <PrimarySidebarLayoutWithSections
      tabs={tabs}
      activeTab="benchmark"
      onTabChange={() => {}}
      hideTabs
    />
  );
});

BenchmarkTabSidebar.displayName = "BenchmarkTabSidebar";

registerTabSidebar("benchmark", {
  component: BenchmarkTabSidebar,
  keepAlive: true,
});

export { BenchmarkTabSidebar };
