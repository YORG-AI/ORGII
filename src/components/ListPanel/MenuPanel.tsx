/**
 * MenuPanel — reusable left-panel navigation for split-view pages.
 *
 * Renders icon+label navigation buttons using ListPanel tokens.
 * Optionally shows a TabPill header (like Settings App|Agent toggle).
 * Optionally shows a footer slot (like Creator Studio publish button).
 *
 * Used by: Integrations, Dev Records, Wallet, Creator Studio, Settings, etc.
 */
import React from "react";

import AnyIcon from "@src/components/AnyIcon";
import TabPill from "@src/components/TabPill";
import type { IconSvgElement } from "@src/icons";
import {
  ListPanelScrollArea,
  ListPanelTabPillRow,
} from "@src/modules/shared/layouts/blocks";

import { getListIconClasses, getListItemClasses } from "./tokens";

// ── Types ──

export interface MenuPanelTab<TTab extends string = string> {
  key: TTab;
  label: string;
}

export interface MenuPanelItem<TKey extends string = string> {
  key: TKey;
  label: string;
  icon: IconSvgElement;
}

export interface MenuPanelProps<
  TKey extends string = string,
  TTab extends string = string,
> {
  /** Navigation items rendered as icon+label buttons */
  items: MenuPanelItem<TKey>[];
  /** Currently active item key */
  activeView: TKey;
  /** Callback when an item is clicked */
  onViewChange: (view: TKey) => void;

  /** Optional TabPill tabs shown above the menu items */
  tabs?: MenuPanelTab<TTab>[];
  /** Active tab key (required when tabs is provided) */
  activeTab?: TTab;
  /** Tab change callback (required when tabs is provided) */
  onTabChange?: (tab: TTab) => void;

  /** Optional footer content (e.g. action button) */
  footer?: React.ReactNode;

  /** Top padding of the list area below header/search. Default: "default" (pt-2). Use "none" to remove. */
  listPaddingTop?: "default" | "none";
}

// ── Component ──

export function MenuPanel<
  TKey extends string = string,
  TTab extends string = string,
>({
  items,
  activeView,
  onViewChange,
  tabs,
  activeTab,
  onTabChange,
  footer,
  listPaddingTop = "default",
}: MenuPanelProps<TKey, TTab>) {
  return (
    <div className="flex h-full flex-col">
      {tabs && activeTab !== undefined && onTabChange && (
        <ListPanelTabPillRow>
          <TabPill
            activeTab={activeTab}
            tabs={tabs}
            onChange={(key) => onTabChange(key as TTab)}
            variant="pill"
            size="default"
            className="w-full"
          />
        </ListPanelTabPillRow>
      )}

      <ListPanelScrollArea listPaddingTop={listPaddingTop}>
        <div className="flex flex-col gap-1">
          {items.map((item) => {
            const isActive = activeView === item.key;
            return (
              <button
                key={item.key}
                onClick={() => onViewChange(item.key)}
                className={`w-full border-none text-left ${getListItemClasses(isActive)}`}
              >
                <AnyIcon
                  icon={item.icon}
                  size={16}
                  className={getListIconClasses(isActive)}
                />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </ListPanelScrollArea>

      {footer}
    </div>
  );
}
