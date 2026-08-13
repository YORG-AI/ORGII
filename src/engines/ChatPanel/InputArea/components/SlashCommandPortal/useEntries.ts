import { useMemo } from "react";

import {
  AGENT_EXEC_MODES,
  COMPOSER_MODES,
} from "@src/config/sessionCreatorConfig";
import type { SlashItem } from "@src/types/extensions";
import { fuzzyMatch } from "@src/util/search/fuzzy";

import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  FLYOUT_CATEGORIES,
} from "./constants";
import type { ListEntry } from "./types";

interface UseEntriesOptions {
  items: SlashItem[];
  searchQuery: string;
  /** Use the action command layout: Image, Mode, Skills. */
  showActionFlyouts: boolean;
  hasImageUpload: boolean;
  /** When false, hides mode rows in inline search results. */
  showModeRows?: boolean;
  /** Offer the Project product mode alongside the exec modes (§5.2). */
  includeProjectMode?: boolean;
}

interface UseEntriesResult {
  entries: ListEntry[];
  totalFlat: number;
}

/**
 * Builds the unified flat-list entries for the slash command menu.
 *
 * Layout when showActionFlyouts=true and not searching:
 *   Image row (if image upload is available)
 *   Mode section (direct mode rows)
 *   Skills section (direct skill rows)
 *
 * Layout when showActionFlyouts=false (inline / typing mode):
 *   Slash item categories only (flat or flyout per category)
 *
 * When searching, flyout categories are expanded inline for scannable results.
 */
export function useEntries({
  items,
  searchQuery,
  showActionFlyouts,
  hasImageUpload,
  showModeRows = true,
  includeProjectMode = false,
}: UseEntriesOptions): UseEntriesResult {
  return useMemo(() => {
    const result: ListEntry[] = [];
    let idx = 0;
    const isSearching = Boolean(searchQuery);

    if (showActionFlyouts) {
      const query = searchQuery.trim();
      const imageMatches =
        !query ||
        fuzzyMatch(query, "Upload Image") ||
        fuzzyMatch(query, "Image");
      const modeEntries = includeProjectMode
        ? COMPOSER_MODES
        : AGENT_EXEC_MODES;
      const matchedModes = showModeRows
        ? modeEntries.filter(
            (mode) =>
              !query ||
              fuzzyMatch(query, mode.name) ||
              fuzzyMatch(query, mode.id)
          )
        : [];
      const matchedActionItems = items.filter(
        (entry) =>
          entry.category === "action" &&
          (!query ||
            fuzzyMatch(query, entry.name) ||
            fuzzyMatch(query, entry.description ?? ""))
      );
      const matchedWorkspaceSkillItems = items.filter(
        (entry) =>
          entry.category === "skill" &&
          entry.skillScope === "workspace" &&
          (!query ||
            fuzzyMatch(query, entry.name) ||
            fuzzyMatch(query, entry.description ?? ""))
      );
      const matchedUserSkillItems = items.filter(
        (entry) =>
          entry.category === "skill" &&
          entry.skillScope !== "workspace" &&
          (!query ||
            fuzzyMatch(query, entry.name) ||
            fuzzyMatch(query, entry.description ?? ""))
      );

      if (hasImageUpload && imageMatches) {
        result.push({ kind: "image", flatIndex: idx++ });
      }

      if (matchedModes.length > 0) {
        if (result.length > 0) result.push({ kind: "divider" });
        result.push({
          kind: "header",
          label: "Mode",
          translationKey: "creator.slashMenu.mode",
        });
        for (const mode of matchedModes) {
          result.push({ kind: "mode", mode, flatIndex: idx++ });
        }
      }

      if (matchedActionItems.length > 0) {
        if (result.length > 0) result.push({ kind: "divider" });
        result.push({
          kind: "header",
          label: "Commands",
          translationKey: "creator.slashMenu.commands",
        });
        for (const item of matchedActionItems) {
          result.push({ kind: "item", item, flatIndex: idx++ });
        }
      }

      if (matchedWorkspaceSkillItems.length > 0) {
        if (result.length > 0) result.push({ kind: "divider" });
        result.push({
          kind: "header",
          label: "Workspace Skills",
          translationKey: "creator.slashMenu.workspaceSkills",
        });
        for (const item of matchedWorkspaceSkillItems) {
          result.push({ kind: "item", item, flatIndex: idx++ });
        }
      }

      if (matchedUserSkillItems.length > 0) {
        if (result.length > 0) result.push({ kind: "divider" });
        result.push({
          kind: "header",
          label: "User Skills",
          translationKey: "creator.slashMenu.userSkills",
        });
        for (const item of matchedUserSkillItems) {
          result.push({ kind: "item", item, flatIndex: idx++ });
        }
      }

      return { entries: result, totalFlat: idx };
    }

    // ── Inline / search path ─────────────────────────────────────────────────

    const query = searchQuery.trim();
    const matchedWorkspaceSkillItems = items.filter(
      (entry) =>
        entry.category === "skill" &&
        entry.skillScope === "workspace" &&
        (!query ||
          fuzzyMatch(query, entry.name) ||
          fuzzyMatch(query, entry.description ?? ""))
    );
    const matchedUserSkillItems = items.filter(
      (entry) =>
        entry.category === "skill" &&
        entry.skillScope !== "workspace" &&
        (!query ||
          fuzzyMatch(query, entry.name) ||
          fuzzyMatch(query, entry.description ?? ""))
    );

    if (matchedWorkspaceSkillItems.length > 0) {
      result.push({
        kind: "header",
        label: "Workspace Skills",
        translationKey: "creator.slashMenu.workspaceSkills",
      });
      for (const item of matchedWorkspaceSkillItems) {
        result.push({ kind: "item", item, flatIndex: idx++ });
      }
    }

    if (matchedUserSkillItems.length > 0) {
      if (result.length > 0) result.push({ kind: "divider" });
      result.push({
        kind: "header",
        label: "User Skills",
        translationKey: "creator.slashMenu.userSkills",
      });
      for (const item of matchedUserSkillItems) {
        result.push({ kind: "item", item, flatIndex: idx++ });
      }
    }

    // Mode rows when showActionFlyouts=false and searching (filter by query)
    if (showModeRows && !showActionFlyouts && isSearching) {
      const matchedModes = (
        includeProjectMode ? COMPOSER_MODES : AGENT_EXEC_MODES
      ).filter(
        (m) => fuzzyMatch(searchQuery, m.name) || fuzzyMatch(searchQuery, m.id)
      );
      if (matchedModes.length > 0) {
        result.push({
          kind: "header",
          label: "Mode",
          translationKey: "creator.slashMenu.mode",
        });
        for (const mode of matchedModes) {
          result.push({ kind: "mode", mode, flatIndex: idx++ });
        }
      }
    }

    // Slash item categories (flat when searching, flyout when not)
    for (const category of CATEGORY_ORDER) {
      if (category === "skill") continue;
      const catItems = items.filter((item) => item.category === category);
      if (catItems.length === 0) continue;

      if (!isSearching && FLYOUT_CATEGORIES.has(category)) {
        result.push({
          kind: "flyout",
          category,
          label: CATEGORY_LABELS[category],
          items: catItems,
          flatIndex: idx++,
        });
      } else {
        result.push({ kind: "header", label: CATEGORY_LABELS[category] });
        for (const item of catItems) {
          result.push({ kind: "item", item, flatIndex: idx++ });
        }
      }
    }

    return { entries: result, totalFlat: idx };
  }, [
    items,
    searchQuery,
    showActionFlyouts,
    hasImageUpload,
    showModeRows,
    includeProjectMode,
  ]);
}
