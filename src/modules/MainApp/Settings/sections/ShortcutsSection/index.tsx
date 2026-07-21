/**
 * Shortcuts Section - VS Code-style keyboard shortcuts viewer
 *
 * Features:
 * - Searchable table of all shortcuts
 * - Filter by system (Mac / Windows / Linux) — defaults to the user's
 *   current OS so the displayed keys match their actual keyboard
 * - Filter by category
 * - Organized by scope
 */
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import KeyBadge from "@src/components/KeyBadge";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
  type SettingsTableSelectFilter,
} from "@src/components/SettingsTable";

import {
  ALL_SHORTCUTS,
  CATEGORY_CONFIG,
  SCOPE_LABELS,
  type ShortcutCategory,
  type ShortcutEntry,
  getCategories,
} from "./config";

type OsFilter = "mac" | "windows" | "linux";

/** Detect the user's OS from `navigator.platform`; defaults to Windows. */
function detectCurrentOs(): OsFilter {
  if (typeof navigator === "undefined") return "windows";
  const platform = navigator.platform.toUpperCase();
  if (platform.includes("MAC")) return "mac";
  if (platform.includes("LINUX")) return "linux";
  return "windows";
}

const CURRENT_OS = detectCurrentOs();

const ShortcutsSection: React.FC = () => {
  const { t } = useTranslation("settings");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<
    ShortcutCategory | "all"
  >("all");
  const [selectedOs, setSelectedOs] = useState<OsFilter>(CURRENT_OS);

  // Only Mac has a distinct symbol set; Linux conventionally shares the
  // Windows/Ctrl-based keybindings.
  const useMacKeys = selectedOs === "mac";

  const categories = useMemo(() => getCategories(), []);

  const tableFilters = useMemo<SettingsTableSelectFilter[]>(
    () => [
      {
        key: "system",
        value: selectedOs,
        // No "all" option: a shortcut row can only display one keystroke
        // column at a time. The OS filter is always "active" and resets
        // to the user's current platform.
        defaultValue: CURRENT_OS,
        options: [
          { value: "mac", label: t("shortcuts.systemMac") },
          { value: "windows", label: t("shortcuts.systemWindows") },
          { value: "linux", label: t("shortcuts.systemLinux") },
        ],
        onChange: (value) => setSelectedOs(value as OsFilter),
        minWidth: 120,
      },
      {
        key: "category",
        value: selectedCategory,
        defaultValue: "all",
        options: [
          { value: "all", label: t("shortcuts.allTab") },
          ...categories.map((category) => ({
            value: category,
            label: CATEGORY_CONFIG[category]?.label || category,
          })),
        ],
        onChange: (value) =>
          setSelectedCategory(value as ShortcutCategory | "all"),
        minWidth: 140,
      },
    ],
    [categories, selectedCategory, selectedOs, t]
  );

  // Filter shortcuts based on search and category
  const filteredShortcuts = useMemo(() => {
    let shortcuts = ALL_SHORTCUTS;

    // Filter by category
    if (selectedCategory !== "all") {
      shortcuts = shortcuts.filter(
        (shortcut) => shortcut.category === selectedCategory
      );
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      shortcuts = shortcuts.filter(
        (shortcut) =>
          shortcut.command.toLowerCase().includes(query) ||
          shortcut.macKeys.toLowerCase().includes(query) ||
          shortcut.winKeys.toLowerCase().includes(query) ||
          SCOPE_LABELS[shortcut.scope]?.toLowerCase().includes(query) ||
          CATEGORY_CONFIG[shortcut.category]?.label
            .toLowerCase()
            .includes(query)
      );
    }

    return shortcuts;
  }, [searchQuery, selectedCategory]);

  const columns: SettingsTableColumn<ShortcutEntry>[] = useMemo(
    () => [
      {
        key: "command",
        label: t("shortcuts.command"),
        width: "320px",
        sorter: (entryA, entryB) =>
          entryA.command.localeCompare(entryB.command),
        renderCell: (entry) => (
          <span className={SETTINGS_TABLE_CELL.primary}>{entry.command}</span>
        ),
      },
      {
        key: "keybinding",
        label: t("shortcuts.keybinding"),
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (entry) => (
          <KeyBadge
            keys={useMacKeys ? entry.macKeys : entry.winKeys}
            showSeparator={false}
          />
        ),
      },
      {
        key: "context",
        label: `${t("shortcuts.when")} / ${t("shortcuts.category")}`,
        width: "180px",
        sorter: (entryA, entryB) => {
          const scopeCompare = entryA.scope.localeCompare(entryB.scope);
          if (scopeCompare !== 0) return scopeCompare;
          return entryA.category.localeCompare(entryB.category);
        },
        renderCell: (entry) => (
          <div className="inline-flex items-center whitespace-nowrap text-text-2">
            <span>{SCOPE_LABELS[entry.scope] || entry.scope}</span>
            <span className="mx-2 h-3.5 w-px bg-border-2" />
            <span>
              {CATEGORY_CONFIG[entry.category]?.label || entry.category}
            </span>
          </div>
        ),
      },
    ],
    [t, useMacKeys]
  );

  return (
    <div className="flex w-full flex-col gap-4">
      <SettingsTable<ShortcutEntry>
        hover
        selectFilters={tableFilters}
        searchBar={{
          searchValue: searchQuery,
          onSearchChange: setSearchQuery,
          searchPlaceholder: t("shortcuts.searchPlaceholder"),
          allowSearchClear: true,
        }}
        columns={columns}
        rows={filteredShortcuts}
        getRowKey={(entry) => entry.id}
        headerHeight="tall"
        emptyTitle={t("shortcuts.noResults")}
        emptySubtitle={searchQuery ? t("shortcuts.noResultsHint") : undefined}
      />

      <div className="rounded-lg bg-primary-container p-4">
        <div className="mb-2 text-sm font-medium text-text-1">
          {t("shortcuts.tipsHeading")}
        </div>
        <ul className="space-y-1 text-xs text-text-3">
          <li>
            {"• "}
            {useMacKeys
              ? t("shortcuts.tipsModifiersMac")
              : t("shortcuts.tipsModifiersWin")}
          </li>
          <li>{`• ${t("shortcuts.tipsEditorScope")}`}</li>
          <li>{`• ${t("shortcuts.tipsContextual")}`}</li>
          <li>{`• ${t("shortcuts.tipsSearchHint")}`}</li>
        </ul>
      </div>
    </div>
  );
};

export default ShortcutsSection;
