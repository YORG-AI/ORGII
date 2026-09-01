import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { ProcessStopButton } from "@src/components/ProcessStopButton";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  HugeiconsIcon,
} from "@src/icons";
import { MINI_TERMINAL_SESSION_LIMIT } from "@src/store/ui/miniTerminalAtom";

import { WorkstationTrailHeader, WorkstationTrailIconButton } from "../blocks";

export interface TrailTerminalTab {
  key: string;
  label: string;
}

interface WorkstationTrailTerminalHeaderProps {
  activeId: string | null;
  collapsed: boolean;
  panelId: string;
  tabs: TrailTerminalTab[];
  onSelect: (id: string) => void;
  onToggleCollapsed: () => void;
  onAdd: () => void;
  onHide: () => void;
  onStop: (id: string) => void;
}

export function WorkstationTrailTerminalHeader({
  activeId,
  collapsed,
  panelId,
  tabs,
  onSelect,
  onToggleCollapsed,
  onAdd,
  onHide,
  onStop,
}: WorkstationTrailTerminalHeaderProps) {
  const { t } = useTranslation();
  const tabListRef = useRef<HTMLDivElement>(null);
  const activeTab = tabs.find((tab) => tab.key === activeId);
  useLayoutEffect(() => {
    const list = tabListRef.current;
    const selected = list?.querySelector<HTMLButtonElement>(
      '[aria-selected="true"]'
    );
    if (!list || !selected || collapsed) return;
    // Reveal only within the tab strip; never scroll the surrounding chat.
    const listRect = list.getBoundingClientRect();
    const tabRect = selected.getBoundingClientRect();
    if (!listRect.width) return;
    const scale = list.offsetWidth ? listRect.width / list.offsetWidth : 1;
    if (tabRect.left < listRect.left)
      list.scrollLeft += (tabRect.left - listRect.left) / scale;
    else if (tabRect.right > listRect.right)
      list.scrollLeft += (tabRect.right - listRect.right) / scale;
  }, [activeId, collapsed]);
  const terminalsLabel = t("navigation:labels.terminals");
  const showTabs = !collapsed && tabs.length > 1;
  const title = showTabs ? null : tabs.length > 1 ? (
    t("common:git.rail.terminalProcessCount", { count: tabs.length })
  ) : (
    <span
      id={activeId ? `${panelId}-tab-${activeId}` : undefined}
      className="normal-case"
    >
      {activeTab?.label ?? terminalsLabel}
    </span>
  );

  return (
    <WorkstationTrailHeader
      standalone={collapsed}
      title={title}
      titleActions={
        <WorkstationTrailIconButton
          className="pointer-events-none opacity-0 transition-opacity group-focus-within/workstation-trail-terminal:pointer-events-auto group-focus-within/workstation-trail-terminal:opacity-100 group-hover/workstation-trail-terminal:pointer-events-auto group-hover/workstation-trail-terminal:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
          onClick={onToggleCollapsed}
          aria-label={t(
            collapsed ? "common:actions.expand" : "common:actions.collapse"
          )}
          aria-expanded={!collapsed}
        >
          <HugeiconsIcon
            icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
            data-icon={collapsed ? "chevron-right" : "chevron-down"}
            size={14}
            strokeWidth={1.75}
          />
        </WorkstationTrailIconButton>
      }
      actions={
        <>
          {!collapsed && activeTab ? (
            <ProcessStopButton
              className="rounded-lg"
              size="sm"
              label={t("common:tooltips.killTerminal")}
              onClick={() => onStop(activeTab.key)}
            />
          ) : null}
          {tabs.length < MINI_TERMINAL_SESSION_LIMIT ? (
            <WorkstationTrailIconButton
              onClick={onAdd}
              aria-label={t("common:git.rail.newMiniTerminal")}
              title={t("common:git.rail.newMiniTerminal")}
            >
              <HugeiconsIcon
                icon={Add01Icon}
                data-icon="plus"
                size={14}
                strokeWidth={1.75}
              />
            </WorkstationTrailIconButton>
          ) : null}
          <WorkstationTrailIconButton
            onClick={onHide}
            aria-label={t("common:git.rail.hideMiniTerminal")}
            title={t("common:git.rail.hideMiniTerminal")}
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              data-icon="x"
              size={14}
              strokeWidth={1.75}
            />
          </WorkstationTrailIconButton>
        </>
      }
    >
      {showTabs ? (
        <div
          ref={tabListRef}
          role="tablist"
          aria-label={terminalsLabel}
          className="scrollbar-hide flex min-w-0 flex-1 items-center gap-px overflow-x-auto py-0.5"
          onKeyDown={(event) => {
            const index = tabs.findIndex((tab) => tab.key === activeId);
            let next: number;
            switch (event.key) {
              case "ArrowLeft":
                next = (index - 1 + tabs.length) % tabs.length;
                break;
              case "ArrowRight":
                next = (index + 1) % tabs.length;
                break;
              case "Home":
                next = 0;
                break;
              case "End":
                next = tabs.length - 1;
                break;
              default:
                return;
            }
            event.preventDefault();
            onSelect(tabs[next].key);
            event.currentTarget
              .querySelectorAll<HTMLButtonElement>('[role="tab"]')
              [next]?.focus({ preventScroll: true });
          }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              id={`${panelId}-tab-${tab.key}`}
              aria-controls={panelId}
              aria-selected={tab.key === activeId}
              tabIndex={tab.key === activeId ? 0 : -1}
              title={tab.label}
              onClick={() => onSelect(tab.key)}
              className={`h-5 max-w-28 shrink-0 truncate rounded-lg px-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-6 ${tab.key === activeId ? "bg-fill-2 font-medium text-text-1" : "text-text-3 hover:bg-fill-2 hover:text-text-1"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}
    </WorkstationTrailHeader>
  );
}
