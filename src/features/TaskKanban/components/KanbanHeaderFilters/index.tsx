import { useAtom } from "jotai";
import React, { memo, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { IMPORTED_HISTORY_SOURCES } from "@src/api/tauri/externalHistory";
import { CLI_AGENT, type CliAgentType } from "@src/api/types/keys";
import { formatAgentType } from "@src/assets/providers";
import Button from "@src/components/Button";
import {
  ActionMenuSurface,
  ActionSubmenu,
} from "@src/components/Dropdown/ActionMenuSurface";
import DropdownItem from "@src/components/Dropdown/DropdownItem";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import type { KanbanTask } from "@src/features/KanbanBoard";
import { getDropdownPanelStyle, useDropdownEngine } from "@src/hooks/dropdown";
import {
  ArchiveIcon,
  Clock01Icon,
  FilterIcon,
  HugeiconsIcon,
  UserMultipleIcon,
} from "@src/icons";
import { kanbanAgentTypeFilterAtom } from "@src/store/ui/kanbanViewStateAtom";

import {
  DEFAULT_KANBAN_TIME_FILTER,
  EXTERNAL_HISTORY_FILTER_BY_SOURCE,
  KANBAN_AGENT_TYPE_FILTER,
  KANBAN_AUTO_ARCHIVE_TTLS,
  KANBAN_TIME_FILTERS,
  type KanbanAgentTypeFilter,
  type KanbanAutoArchiveTtl,
  type KanbanTimeFilter,
} from "../../config";

const DEFAULT_AUTO_ARCHIVE_TTL: KanbanAutoArchiveTtl = "24h";

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

interface KanbanHeaderFiltersProps {
  tasks: readonly KanbanTask[];
  autoArchiveTtl: KanbanAutoArchiveTtl;
  onAutoArchiveTtlChange: (ttl: KanbanAutoArchiveTtl) => void;
  timeFilter: KanbanTimeFilter;
  onTimeFilterChange: (filter: KanbanTimeFilter) => void;
}

const KanbanHeaderFilters: React.FC<KanbanHeaderFiltersProps> = memo(
  ({
    tasks,
    autoArchiveTtl,
    onAutoArchiveTtlChange,
    timeFilter,
    onTimeFilterChange,
  }) => {
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

    const {
      isOpen,
      isPositioned,
      toggle,
      close,
      triggerRef,
      panelRef,
      panelPosition,
    } = useDropdownEngine<HTMLButtonElement>({
      align: "right",
      placement: "bottom",
      captureKeyboardFocus: true,
      // ActionMenuSurface owns keyboard navigation across the submenus.
      autoKeyboardNavigation: false,
      closeOnEsc: false,
    });

    const activeAgentLabel = getFilterLabel(
      agentTypeFilterItems.find((item) => item.key === activeAgentTypeFilter) ??
        ALL_AGENT_TYPE_FILTER_ITEM,
      t
    );
    const activeAutoArchiveLabel = t(
      KANBAN_AUTO_ARCHIVE_TTLS.find((item) => item.key === autoArchiveTtl)
        ?.labelKey ?? "kanban.autoArchive.24h"
    );
    const activeTimeFilterLabel = t(
      KANBAN_TIME_FILTERS.find((item) => item.key === timeFilter)?.labelKey ??
        "kanban.timeFilter.3d"
    );
    const hasNonDefaultFilters =
      activeAgentTypeFilter !== KANBAN_AGENT_TYPE_FILTER.ALL ||
      autoArchiveTtl !== DEFAULT_AUTO_ARCHIVE_TTL ||
      timeFilter !== DEFAULT_KANBAN_TIME_FILTER;

    return (
      <>
        <Button
          ref={triggerRef}
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          className={
            isOpen || hasNonDefaultFilters ? "bg-fill-1! text-primary-6!" : ""
          }
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
          aria-label={t("common:actions.filter")}
          aria-haspopup="menu"
          aria-expanded={isOpen}
          aria-pressed={hasNonDefaultFilters}
          data-testid="kanban-filter-menu-trigger"
          icon={
            <HugeiconsIcon
              icon={FilterIcon}
              data-icon="filter"
              size={HEADER_ICON_SIZE.sm}
              strokeWidth={2}
            />
          }
        />
        {isOpen &&
          isPositioned &&
          createPortal(
            <ActionMenuSurface
              panelRef={panelRef}
              onClose={close}
              fitSubmenus
              className={`${DROPDOWN_CLASSES.menuPanelBase} ${DROPDOWN_WIDTHS.sidebarMenuClass}`}
              style={{
                ...getDropdownPanelStyle(panelPosition, {
                  widthMode: "none",
                }),
                position: "fixed",
                zIndex: DROPDOWN_PANEL.zIndex,
              }}
            >
              <ActionSubmenu
                label={t("common:terminology.agent")}
                value={activeAgentLabel}
                icon={
                  <HugeiconsIcon
                    icon={UserMultipleIcon}
                    size={DROPDOWN_ITEM.iconSize}
                    strokeWidth={1.75}
                  />
                }
                dataTestId="kanban-filter-agent-submenu"
              >
                {agentTypeFilterItems.map((item) => {
                  const label = getFilterLabel(item, t);
                  const selected = item.key === activeAgentTypeFilter;
                  return (
                    <DropdownItem
                      key={item.key}
                      role="menuitemradio"
                      ariaChecked={selected}
                      ariaLabel={label}
                      tabIndex={0}
                      fullWidth
                      selected={selected}
                      onClick={() => setActiveAgentTypeFilter(item.key)}
                      dataTestId={`kanban-filter-agent-${item.key}`}
                    >
                      {label}
                    </DropdownItem>
                  );
                })}
              </ActionSubmenu>
              <ActionSubmenu
                label={t("kanban.autoArchive.label")}
                value={activeAutoArchiveLabel}
                icon={
                  <HugeiconsIcon
                    icon={ArchiveIcon}
                    size={DROPDOWN_ITEM.iconSize}
                    strokeWidth={1.75}
                  />
                }
                dataTestId="kanban-filter-auto-archive-submenu"
              >
                {KANBAN_AUTO_ARCHIVE_TTLS.map((item) => {
                  const label = t(item.labelKey);
                  const selected = item.key === autoArchiveTtl;
                  return (
                    <DropdownItem
                      key={item.key}
                      role="menuitemradio"
                      ariaChecked={selected}
                      ariaLabel={label}
                      tabIndex={0}
                      fullWidth
                      selected={selected}
                      onClick={() => onAutoArchiveTtlChange(item.key)}
                      dataTestId={`kanban-filter-auto-archive-${item.key}`}
                    >
                      {label}
                    </DropdownItem>
                  );
                })}
              </ActionSubmenu>
              <ActionSubmenu
                label={t("kanban.timeFilter.label")}
                value={activeTimeFilterLabel}
                icon={
                  <HugeiconsIcon
                    icon={Clock01Icon}
                    size={DROPDOWN_ITEM.iconSize}
                    strokeWidth={1.75}
                  />
                }
                dataTestId="kanban-filter-range-submenu"
              >
                {KANBAN_TIME_FILTERS.map((item) => {
                  const label = t(item.labelKey);
                  const selected = item.key === timeFilter;
                  return (
                    <DropdownItem
                      key={item.key}
                      role="menuitemradio"
                      ariaChecked={selected}
                      ariaLabel={label}
                      tabIndex={0}
                      fullWidth
                      selected={selected}
                      onClick={() => onTimeFilterChange(item.key)}
                      dataTestId={`kanban-filter-range-${item.key}`}
                    >
                      {label}
                    </DropdownItem>
                  );
                })}
              </ActionSubmenu>
            </ActionMenuSurface>,
            document.body
          )}
      </>
    );
  }
);

KanbanHeaderFilters.displayName = "KanbanHeaderFilters";

export default KanbanHeaderFilters;
