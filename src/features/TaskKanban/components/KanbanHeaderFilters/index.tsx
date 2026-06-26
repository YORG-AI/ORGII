import { useAtom, useAtomValue } from "jotai";
import React, { memo, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  IMPORTED_HISTORY_SOURCES,
  type ImportedHistorySourceId,
} from "@src/api/tauri/importedHistory";
import { DISPATCH_CATEGORY } from "@src/api/tauri/session";
import { CLI_AGENT, type CliAgentType } from "@src/api/types/keys";
import { formatAgentType } from "@src/assets/providers";
import type { DropdownOption } from "@src/components/Dropdown/types";
import Select from "@src/components/Select";
import { sessionsAtom } from "@src/store/session";
import { kanbanAgentTypeFilterAtom } from "@src/store/ui/kanbanViewStateAtom";
import {
  getDispatchCategory,
  getExternalHistorySourceId,
} from "@src/util/session/sessionDispatch";
import { isPrimarySessionListSession } from "@src/util/session/sessionVisibility";

import {
  KANBAN_AGENT_TYPE_FILTER,
  type KanbanAgentTypeFilter,
} from "../../config";

const CLI_AGENT_FILTERS: readonly CliAgentType[] = [
  CLI_AGENT.CURSOR,
  CLI_AGENT.CLAUDE_CODE,
  CLI_AGENT.CODEX,
  CLI_AGENT.GEMINI,
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
  labelKey: "opsControl.filters.allAgents",
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
  key: KANBAN_AGENT_TYPE_FILTER.CURSOR_IDE,
  labelKey: "creator.cursorIde.label",
};

const CLI_AGENT_FILTER_ITEMS = new Map<
  CliAgentType,
  KanbanFilterItem<KanbanAgentTypeFilter>
>(
  CLI_AGENT_FILTERS.map((cliAgentType) => [
    cliAgentType,
    {
      key: cliAgentType as KanbanAgentTypeFilter,
      label: formatAgentType(cliAgentType),
    },
  ])
);

const EXTERNAL_HISTORY_FILTER_BY_SOURCE: Record<
  ImportedHistorySourceId,
  KanbanAgentTypeFilter
> = {
  codex_app: KANBAN_AGENT_TYPE_FILTER.CODEX,
  claude_code: KANBAN_AGENT_TYPE_FILTER.CLAUDE_CODE,
  opencode: KANBAN_AGENT_TYPE_FILTER.OPENCODE,
  windsurf: KANBAN_AGENT_TYPE_FILTER.WINDSURF,
  workbuddy: KANBAN_AGENT_TYPE_FILTER.WORKBUDDY,
};

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

function getAgentTypeFilterForSession(
  sessionId: string,
  cliAgentType: CliAgentType | undefined,
  agentDefinitionId: string | undefined
): KanbanAgentTypeFilter | null {
  const category = getDispatchCategory(sessionId);
  if (category === DISPATCH_CATEGORY.CURSOR_IDE) {
    return KANBAN_AGENT_TYPE_FILTER.CURSOR_IDE;
  }
  if (category === DISPATCH_CATEGORY.CLI_AGENT) {
    return cliAgentType ? (cliAgentType as KanbanAgentTypeFilter) : null;
  }
  if (category === DISPATCH_CATEGORY.EXTERNAL_HISTORY) {
    const sourceId = getExternalHistorySourceId(sessionId);
    return sourceId ? EXTERNAL_HISTORY_FILTER_BY_SOURCE[sourceId] : null;
  }
  if (category === DISPATCH_CATEGORY.RUST_AGENT) {
    return agentDefinitionId ?? null;
  }
  return null;
}

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

const KanbanHeaderFilters: React.FC = memo(() => {
  const { t } = useTranslation(["sessions", "common"]);
  const [activeAgentTypeFilter, setActiveAgentTypeFilter] = useAtom(
    kanbanAgentTypeFilterAtom
  );
  const sessions = useAtomValue(sessionsAtom);

  const agentTypeFilterItems = useMemo(() => {
    const presentFilters = new Set<KanbanAgentTypeFilter>();
    const rustAgentLabels = new Map<string, string>();
    for (const session of sessions) {
      if (!isPrimarySessionListSession(session)) continue;

      const filter = getAgentTypeFilterForSession(
        session.session_id,
        session.cliAgentType,
        session.agentDefinitionId
      );
      if (!filter) continue;
      presentFilters.add(filter);
      if (
        getDispatchCategory(session.session_id) === DISPATCH_CATEGORY.RUST_AGENT
      ) {
        rustAgentLabels.set(filter, session.agentDisplayName ?? filter);
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
    if (presentFilters.has(KANBAN_AGENT_TYPE_FILTER.CURSOR_IDE)) {
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
  }, [sessions]);

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
});

KanbanHeaderFilters.displayName = "KanbanHeaderFilters";

export default KanbanHeaderFilters;
