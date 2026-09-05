import React, { useId } from "react";

import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { HugeiconsIcon, WorkHistoryIcon } from "@src/icons";

export interface RecentTabMenuItem {
  id: string;
  title: string;
  leadingIcon?: React.ReactNode;
}

interface RecentTabsMenuSectionProps {
  tabs: readonly RecentTabMenuItem[];
  label: string;
  onOpen: (tabId: string) => void;
}

export function RecentTabsMenuSection({
  tabs,
  label,
  onOpen,
}: RecentTabsMenuSectionProps): React.ReactNode {
  const labelId = useId();

  if (tabs.length === 0) return null;

  return (
    <>
      <div className={DROPDOWN_CLASSES.menuGroupSeparator} aria-hidden />
      <div role="group" aria-labelledby={labelId}>
        <div id={labelId} className={DROPDOWN_CLASSES.sectionLabel}>
          {label}
        </div>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="menuitem"
            className={DROPDOWN_CLASSES.menuActionItem}
            data-recent-tab-id={tab.id}
            onClick={() => onOpen(tab.id)}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {tab.leadingIcon ?? (
                <HugeiconsIcon
                  icon={WorkHistoryIcon}
                  data-icon="work-history"
                  size={HEADER_ICON_SIZE.sm}
                  strokeWidth={1.8}
                />
              )}
              <span className="truncate">{tab.title}</span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
