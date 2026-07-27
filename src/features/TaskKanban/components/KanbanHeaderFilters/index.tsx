import { useAtom } from "jotai";
import React, { memo, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { IMPORTED_HISTORY_SOURCES } from "@src/api/tauri/externalHistory";
import { CLI_AGENT, type CliAgentType } from "@src/api/types/keys";
import { formatAgentType } from "@src/assets/providers";
import type { DropdownOption } from "@src/components/Dropdown/types";
import Select from "@src/components/Select";
import type { KanbanTask } from "@src/features/KanbanBoard";
import { kanbanAgentTypeFilterAtom } from "@src/store/ui/kanbanViewStateAtom";

import {
  EXTERNAL_HISTORY_FILTER_BY_SOURCE,
  KANBAN_AGENT_TYPE_FILTER,
  type KanbanAgentTypeFilter,
} from "../../config";

const CLI_AGENT_FILTERS: readonly CliAgentType[] = [
  CLI_AGENT.CURSOR,
  CLI_AGENT.CLAUDE_CODE,
  CLI_AGENT.CODEX,
  CLI_AGENT.COPILOT,
  CLI_AGENT.KIRO,
  CLI_AGENT.KIMI,
  CLI_AGENT.OPENCODE,
];
interface KanbanFilterItem<TFilter extends string> {
  key: TFilter;
  label?: string;
  labelKey?: string;
}

const ALL_AGENT_TYPE_FILTER_ITEM: KanbanFilterItem<KanbanAgentTypeFilter> = {
  key: KANBAN_AGENT_TYPE_FILTER.ALL,
  labelKey: "kanban.filters.allAgents",
};

const RUST_AGENT_FILTER_ITEMS: Record<
  | typeof KANBAN_AGENT_TYPE_FILTER.OS_AGENT
  | typeof KANBAN_AGENT_TYPE_FILTER.SDE_AGENT,
  KanbanFilterItem<KanbanAgentTypeFilter>
> = {
  [KANBAN_AGENT_TYPE_FILTER.OS_AGENT]: {
    key: KANBAN_AGENT_TYPE_FILTER.OS_AGENT,
    labelKey: "creator.osAgent",
  },
  [KANBAN_AGENT_TYPE_FILTER.SDE_AGENT]: {
    key: KANBAN_AGENT_TYPE_FILTER.SDE_AGENT,
    labelKey: "creator.agent",
  },
};

const CURSOR_IDE_FILTER_ITEM: KanbanFilterItem<KanbanAgentTypeFilter> = {
  key: KANBAN_AGENT_TYPE_FILTER.CURSOR_APP,
  label: "Cursor App",
};

function formatCliFilterLabel(cliAgentType: CliAgentType): string {
  switch (cliAgentType) {
    case CLI_AGENT.CURSOR:
      return "Cursor CLI";
    case CLI_AGENT.CLAUDE_CODE:
      return "Claude CLI";
    case CLI_AGENT.CODEX:
      return "Codex CLI";
    case CLI_AGENT.OPENCODE:
      return "OpenCode CLI";
    default:
      return formatAgentType(cliAgentType);
  }
}

const CLI_AGENT_FILTER_ITEMS = new Map<
  CliAgentType,
  KanbanFilterItem<KanbanAgentTypeFilter>
>(
  CLI_AGENT_FILTERS.map((cliAgentType) => [
    cliAgentType,
    {
      key: cliAgentType as KanbanAgentTypeFilter,
      label: formatCliFilterLabel(cliAgentType),
    },
  ])
);

const EXTERNAL_HISTORY_FILTER_ITEMS = new Map<
  KanbanAgentTypeFilter,
  KanbanFilterItem<KanbanAgentTypeFilter>
>(
  IMPORTED_HISTORY_SOURCES.map((source) => [
    EXTERNAL_HISTORY_FILTER_BY_SOURCE[source.sourceId],
    {
      key: EXTERNAL_HISTORY_FILTER_BY_SOURCE[source.sourceId],
      label: source.displayName,
    },
  ])
);

function getFilterLabel<TFilter extends string>(
  item: KanbanFilterItem<TFilter>,
  translate: (key: string) => string
): string {
  return item.label ?? (item.labelKey ? translate(item.labelKey) : item.key);
}

function buildSelectOption<TFilter extends string>(
  item: KanbanFilterItem<TFilter>,
  translate: (key: string) => string
): DropdownOption {
  const label = getFilterLabel(item, translate);
  return {
    value: item.key,
    label: <span className="whitespace-nowrap">{label}</span>,
    triggerLabel: label,
  };
}

interface KanbanHeaderFiltersProps {
  tasks: readonly KanbanTask[];
}

const KanbanHeaderFilters: React.FC<KanbanHeaderFiltersProps> = memo(
  ({ tasks }) => {
    const { t } = useTranslation(["sessions", "common"]);
    const [activeAgentTypeFilter, setActiveAgentTypeFilter] = useAtom(
      kanbanAgentTypeFilterAtom
    );

    const agentTypeFilterItems = useMemo(() => {
      const presentFilters = new Set<KanbanAgentTypeFilter>();
      const rustAgentLabels = new Map<string, string>();
      for (const task of tasks) {
        const filter = task.agentTypeFilter;
        if (!filter) continue;
        presentFilters.add(filter);
        if (task.agentTypeFilterKind === "rust") {
          rustAgentLabels.set(filter, task.agentTypeFilterLabel ?? filter);
        }
      }

      const items: KanbanFilterItem<KanbanAgentTypeFilter>[] = [
        ALL_AGENT_TYPE_FILTER_ITEM,
      ];
      for (const filter of [
        KANBAN_AGENT_TYPE_FILTER.OS_AGENT,
        KANBAN_AGENT_TYPE_FILTER.SDE_AGENT,
      ] as const) {
        if (presentFilters.has(filter)) {
          items.push(RUST_AGENT_FILTER_ITEMS[filter]);
        }
      }
      const customRustFilters = Array.from(rustAgentLabels.entries())
        .filter(
          ([filter]) =>
            filter !== KANBAN_AGENT_TYPE_FILTER.OS_AGENT &&
            filter !== KANBAN_AGENT_TYPE_FILTER.SDE_AGENT
        )
        .sort(([, labelA], [, labelB]) => labelA.localeCompare(labelB));
      for (const [filter, label] of customRustFilters) {
        items.push({
          key: filter,
          label,
        });
      }
      if (presentFilters.has(KANBAN_AGENT_TYPE_FILTER.CURSOR_APP)) {
        items.push(CURSOR_IDE_FILTER_ITEM);
      }
      for (const item of EXTERNAL_HISTORY_FILTER_ITEMS.values()) {
        if (presentFilters.has(item.key)) {
          items.push(item);
        }
      }
      for (const cliAgentType of CLI_AGENT_FILTERS) {
        if (presentFilters.has(cliAgentType as KanbanAgentTypeFilter)) {
          const item = CLI_AGENT_FILTER_ITEMS.get(cliAgentType);
          if (item) items.push(item);
        }
      }
      return items;
    }, [tasks]);

    useEffect(() => {
      const selectedFilterExists = agentTypeFilterItems.some(
        (item) => item.key === activeAgentTypeFilter
      );
      if (!selectedFilterExists) {
        setActiveAgentTypeFilter(
          agentTypeFilterItems[0]?.key ?? KANBAN_AGENT_TYPE_FILTER.ALL
        );
      }
    }, [activeAgentTypeFilter, agentTypeFilterItems, setActiveAgentTypeFilter]);

    const agentTypeOptions = useMemo(
      () => agentTypeFilterItems.map((item) => buildSelectOption(item, t)),
      [agentTypeFilterItems, t]
    );

    const handleAgentTypeSelect = useCallback(
      (value: string | number | (string | number)[]) => {
        if (Array.isArray(value)) return;
        setActiveAgentTypeFilter(value as KanbanAgentTypeFilter);
      },
      [setActiveAgentTypeFilter]
    );

    return (
      <Select
        value={activeAgentTypeFilter}
        onChange={handleAgentTypeSelect}
        options={agentTypeOptions}
        size="small"
        variant="ghost"
        radius="lg"
        dropdownWidthMode="auto"
        className="w-auto"
      />
    );
  }
);

KanbanHeaderFilters.displayName = "KanbanHeaderFilters";

export default KanbanHeaderFilters;
