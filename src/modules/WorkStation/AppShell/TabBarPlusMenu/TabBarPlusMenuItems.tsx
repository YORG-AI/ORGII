import { Box, FileSearch, Globe, ListTodo, ShieldOff } from "lucide-react";
import React from "react";

import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import KeyBadge from "@src/components/KeyBadge";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";

import type { TabBarPlusMenuItem } from "./menuModel";

interface TabBarPlusMenuItemsProps {
  items: readonly TabBarPlusMenuItem[];
  labels: Record<TabBarPlusMenuItem, string>;
  onSelect: Record<TabBarPlusMenuItem, () => void>;
}

const ICONS: Record<TabBarPlusMenuItem, React.ReactNode> = {
  searchFile: <FileSearch size={HEADER_ICON_SIZE.sm} />,
  newBrowserTab: <Globe size={HEADER_ICON_SIZE.sm} />,
  newPrivateBrowserTab: <ShieldOff size={HEADER_ICON_SIZE.sm} />,
  workItems: <ListTodo size={HEADER_ICON_SIZE.sm} />,
  projects: <Box size={HEADER_ICON_SIZE.sm} />,
};

export function TabBarPlusMenuItems({
  items,
  labels,
  onSelect,
}: TabBarPlusMenuItemsProps) {
  return (
    <>
      {items.map((item) => (
        <button
          key={item}
          type="button"
          onClick={onSelect[item]}
          className={DROPDOWN_CLASSES.menuActionItem}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {ICONS[item]}
            <span className="truncate">{labels[item]}</span>
          </span>
          {item === "searchFile" && (
            <KeyBadge keys="⌘P" showSeparator={false} />
          )}
        </button>
      ))}
    </>
  );
}
