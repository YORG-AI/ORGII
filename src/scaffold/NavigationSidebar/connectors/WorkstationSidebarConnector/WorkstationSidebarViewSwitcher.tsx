import React from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import Tooltip from "@src/components/Tooltip";
import {
  BubbleChatIcon,
  HashtagIcon,
  type IconSvgElement,
  ListTodoIcon,
} from "@src/icons";

export type WorkstationSidebarViewKey = "channels" | "work-items" | "sessions";

interface WorkstationSidebarViewSwitcherProps {
  activeKey: WorkstationSidebarViewKey;
  onChange: (key: WorkstationSidebarViewKey) => void;
}

interface ViewItem {
  key: WorkstationSidebarViewKey;
  label: string;
  icon: IconSvgElement;
}

const SWITCHER_ICON_SIZE = 17;
const SELECTED_VIEW_STYLE: React.CSSProperties = {
  boxShadow: "var(--sidebar-tab-pill-selected-shadow)",
};
const SELECTED_VIEW_TRANSFORM: Record<
  WorkstationSidebarViewKey,
  React.CSSProperties["transform"]
> = {
  "work-items": "translateX(0)",
  sessions: "translateX(calc(100% + 0.25rem))",
  channels: "translateX(calc(200% + 0.5rem))",
};

/** Icon-only primary view switcher rendered below the organization selector. */
export const WorkstationSidebarViewSwitcher: React.FC<WorkstationSidebarViewSwitcherProps> =
  React.memo(({ activeKey, onChange }) => {
    const { t } = useTranslation("navigation");
    const items: ViewItem[] = [
      {
        key: "work-items",
        label: t("labels.workItems"),
        icon: ListTodoIcon,
      },
      {
        key: "sessions",
        label: t("routes.sessions"),
        icon: BubbleChatIcon,
      },
      {
        key: "channels",
        label: t("routes.channels"),
        icon: HashtagIcon,
      },
    ];

    return (
      <nav
        className="shrink-0 px-3 pb-1 pt-1"
        aria-label={t("sidebar.tabs.workstation")}
        data-workstation-sidebar-view-switcher
      >
        <div className="relative grid grid-cols-3 gap-1">
          <div
            className="pointer-events-none absolute inset-0 grid grid-cols-3 gap-1"
            aria-hidden
          >
            <span
              className="col-start-1 h-7 rounded-full bg-chat-pane/70 transition-transform duration-150 ease-out motion-reduce:transition-none"
              style={{
                ...SELECTED_VIEW_STYLE,
                transform: SELECTED_VIEW_TRANSFORM[activeKey],
              }}
              data-testid="sidebar-view-selection"
            />
          </div>
          {items.map((item) => {
            const selected = item.key === activeKey;
            return (
              <Tooltip
                key={item.key}
                content={item.label}
                position="bottom"
                mouseEnterDelay={1500}
                showArrow={false}
              >
                <button
                  type="button"
                  className={`relative z-[1] flex h-7 w-full items-center justify-center rounded-full transition-[background-color,color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-6/30 ${
                    selected
                      ? "cursor-default text-primary-6"
                      : "text-text-2 hover:bg-sidebar-selected hover:text-text-1"
                  }`}
                  aria-label={item.label}
                  aria-current={selected ? "page" : undefined}
                  data-testid={`sidebar-view-${item.key}`}
                  onClick={() => onChange(item.key)}
                >
                  <AnyIcon
                    icon={item.icon}
                    size={SWITCHER_ICON_SIZE}
                    strokeWidth={selected ? 2 : 1.8}
                    aria-hidden
                  />
                </button>
              </Tooltip>
            );
          })}
        </div>
      </nav>
    );
  });

WorkstationSidebarViewSwitcher.displayName = "WorkstationSidebarViewSwitcher";
