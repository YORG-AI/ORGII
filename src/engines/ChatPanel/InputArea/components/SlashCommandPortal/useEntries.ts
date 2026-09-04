import { useMemo } from "react";

import {
  type PinnedAction,
  getPinnedActionKey,
} from "@src/store/session/pinnedActionsAtom";
import type { SlashItem } from "@src/types/extensions";
import { fuzzyMatch } from "@src/util/search/fuzzy";

import type { ListEntry } from "./types";

interface UseEntriesOptions {
  items: SlashItem[];
  searchQuery: string;
  pinnedActions: PinnedAction[];
}

interface UseEntriesResult {
  entries: ListEntry[];
  totalFlat: number;
}

export function buildSkillEntries(
  items: SlashItem[],
  searchQuery: string,
  pinnedActions: ReadonlyArray<PinnedAction> = []
): UseEntriesResult {
  const query = searchQuery.trim();
  const matches = (item: SlashItem) =>
    item.category === "skill" &&
    (!query ||
      fuzzyMatch(query, item.name) ||
      fuzzyMatch(query, item.description ?? ""));
  const matchingSkills = items.filter(matches);
  const matchingSkillByKey = new Map(
    matchingSkills.map((item) => [getPinnedActionKey(item), item])
  );
  const pinnedSkills: SlashItem[] = [];
  const projectedPinnedKeys = new Set<string>();
  for (const action of pinnedActions) {
    if (action.category !== "skill") continue;
    const key = getPinnedActionKey(action);
    const item = matchingSkillByKey.get(key);
    if (!item || projectedPinnedKeys.has(key)) continue;
    projectedPinnedKeys.add(key);
    pinnedSkills.push(item);
  }
  const pinnedKeys = new Set(pinnedSkills.map(getPinnedActionKey));
  const workspaceSkills = matchingSkills.filter(
    (item) =>
      item.skillScope === "workspace" &&
      !pinnedKeys.has(getPinnedActionKey(item))
  );
  const userSkills = matchingSkills.filter(
    (item) =>
      item.skillScope !== "workspace" &&
      !pinnedKeys.has(getPinnedActionKey(item))
  );
  const entries: ListEntry[] = [];
  let flatIndex = 0;

  if (pinnedSkills.length > 0) {
    entries.push({
      kind: "header",
      label: "Pinned",
      translationKey: "common:selectors.repo.sections.pinned",
    });
    for (const item of pinnedSkills) {
      entries.push({ kind: "item", item, flatIndex: flatIndex++ });
    }
  }

  if (workspaceSkills.length > 0) {
    if (entries.length > 0) entries.push({ kind: "divider" });
    entries.push({
      kind: "header",
      label: "Workspace Skills",
      translationKey: "creator.slashMenu.workspaceSkills",
    });
    for (const item of workspaceSkills) {
      entries.push({ kind: "item", item, flatIndex: flatIndex++ });
    }
  }

  if (userSkills.length > 0) {
    if (entries.length > 0) entries.push({ kind: "divider" });
    entries.push({
      kind: "header",
      label: "User Skills",
      translationKey: "creator.slashMenu.userSkills",
    });
    for (const item of userSkills) {
      entries.push({ kind: "item", item, flatIndex: flatIndex++ });
    }
  }

  return { entries, totalFlat: flatIndex };
}

/** Build the skills-only list used by the `/` menu. */
export function useEntries({
  items,
  searchQuery,
  pinnedActions,
}: UseEntriesOptions): UseEntriesResult {
  return useMemo(
    () => buildSkillEntries(items, searchQuery, pinnedActions),
    [items, pinnedActions, searchQuery]
  );
}
