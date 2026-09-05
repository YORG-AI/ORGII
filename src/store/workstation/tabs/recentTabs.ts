import { atom } from "jotai";

import { RECENT_TABS_LIMIT } from "@src/shared/tabs/recentTabs";

import type { WorkStationTab, WorkstationWorkspaceKey } from "./types";

export interface RecentWorkstationTabEntry {
  workspace: WorkstationWorkspaceKey;
  tab: WorkStationTab;
}

/** App-lifetime MRU state, globally capped even when many workspaces are visited. */
export const recentWorkstationTabEntriesAtom = atom<
  RecentWorkstationTabEntry[]
>([]);
recentWorkstationTabEntriesAtom.debugLabel = "recentWorkstationTabEntriesAtom";

export function isSameWorkstationWorkspace(
  left: WorkstationWorkspaceKey,
  right: WorkstationWorkspaceKey
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "global" ||
      (right.kind === "session" && left.sessionId === right.sessionId))
  );
}

function entryId(entry: RecentWorkstationTabEntry): string {
  return entry.workspace.kind === "global"
    ? `global:${entry.tab.id}`
    : `session:${entry.workspace.sessionId}:${entry.tab.id}`;
}

function recordRecentEntry(
  current: readonly RecentWorkstationTabEntry[],
  entry: RecentWorkstationTabEntry
): RecentWorkstationTabEntry[] {
  return [
    entry,
    ...current.filter((candidate) => entryId(candidate) !== entryId(entry)),
  ].slice(0, RECENT_TABS_LIMIT);
}

interface WorkstationTabTransition {
  workspace: WorkstationWorkspaceKey;
  previousTab: WorkStationTab | null | undefined;
  nextTabId: string | null;
}

export const recordWorkstationTabTransitionAtom = atom(
  null,
  (_get, set, transition: WorkstationTabTransition) => {
    const { workspace, previousTab, nextTabId } = transition;
    set(recentWorkstationTabEntriesAtom, (current) => {
      const withoutDestination = nextTabId
        ? current.filter(
            (entry) =>
              !isSameWorkstationWorkspace(entry.workspace, workspace) ||
              entry.tab.id !== nextTabId
          )
        : [...current];
      if (
        !previousTab ||
        previousTab.id === nextTabId ||
        previousTab.type === "start"
      ) {
        return withoutDestination;
      }
      const entry = { workspace, tab: previousTab };
      return recordRecentEntry(withoutDestination, entry);
    });
  }
);
recordWorkstationTabTransitionAtom.debugLabel =
  "recordWorkstationTabTransitionAtom";

export const recordRecentWorkstationTabAtom = atom(
  null,
  (
    _get,
    set,
    input: { workspace: WorkstationWorkspaceKey; tab: WorkStationTab }
  ) => {
    const { workspace, tab } = input;
    if (tab.type === "start") return;
    set(recentWorkstationTabEntriesAtom, (current) => {
      const entry = { workspace, tab };
      return recordRecentEntry(current, entry);
    });
  }
);
recordRecentWorkstationTabAtom.debugLabel = "recordRecentWorkstationTabAtom";

export const removeRecentWorkstationTabAtom = atom(
  null,
  (
    _get,
    set,
    input: { tabId: string; workspace?: WorkstationWorkspaceKey }
  ) => {
    set(recentWorkstationTabEntriesAtom, (current) =>
      current.filter(
        (entry) =>
          entry.tab.id !== input.tabId ||
          (input.workspace !== undefined &&
            !isSameWorkstationWorkspace(entry.workspace, input.workspace))
      )
    );
  }
);
removeRecentWorkstationTabAtom.debugLabel = "removeRecentWorkstationTabAtom";
