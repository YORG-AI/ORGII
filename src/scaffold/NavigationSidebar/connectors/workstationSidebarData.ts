import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { Repo } from "@src/store/repo";
import type { Session, SessionCreatorDraft } from "@src/store/session";

import {
  JOURNEY_MENU_ITEM_ID,
  NEW_SESSION_MENU_ITEM_ID,
  OPS_CONTROL_MENU_ITEM_ID,
  getDraftMenuItemId,
} from "./sidebarConnectorUtils";

export const DEFAULT_COLLAPSED_SECTION_IDS = [
  "yesterday",
  "thisWeek",
  "older",
] as const;

export function sortSessionsByActivity(
  sessions: readonly Session[]
): Session[] {
  return sessions.slice().sort((sessionA, sessionB) => {
    const timestampA =
      sessionA.updated_at || sessionA.updated_time || sessionA.created_at;
    const timestampB =
      sessionB.updated_at || sessionB.updated_time || sessionB.created_at;
    const dateA = timestampA ? new Date(timestampA).getTime() : 0;
    const dateB = timestampB ? new Date(timestampB).getTime() : 0;
    return dateB - dateA;
  });
}

export function buildRepoPathToName(
  repoMap: ReadonlyMap<string, Repo>
): Map<string, string> {
  const pathToName = new Map<string, string>();
  for (const repo of repoMap.values()) {
    const normalizedPath = (repo.path ?? repo.fs_uri ?? "").replace(/\/+$/, "");
    if (normalizedPath) pathToName.set(normalizedPath, repo.name);
  }
  return pathToName;
}

export function getSelectedDraftMenuItemId(
  activeSessionCreatorDraftId: string | null,
  sessionCreatorDrafts: readonly SessionCreatorDraft[]
): string {
  if (
    activeSessionCreatorDraftId &&
    sessionCreatorDrafts.some(
      (draft) => draft.id === activeSessionCreatorDraftId
    )
  ) {
    return getDraftMenuItemId(activeSessionCreatorDraftId);
  }
  return "";
}

export function getSelectedPinnedMenuItemId(
  pathname: string,
  opsControlRoutePath: string,
  journeyRoutePath?: string
): string {
  if (pathname.startsWith(opsControlRoutePath)) {
    return OPS_CONTROL_MENU_ITEM_ID;
  }
  if (journeyRoutePath && pathname.startsWith(journeyRoutePath)) {
    return JOURNEY_MENU_ITEM_ID;
  }
  return "";
}

export function getSelectedMenuItemId({
  selectedPinnedMenuItemId,
  activeSessionId,
  selectedDraftMenuItemId,
}: {
  selectedPinnedMenuItemId: string;
  activeSessionId: string;
  selectedDraftMenuItemId: string;
}): string {
  return (
    selectedPinnedMenuItemId ||
    activeSessionId ||
    selectedDraftMenuItemId ||
    NEW_SESSION_MENU_ITEM_ID
  );
}

export function getAllSectionIds(
  sidebarMenuItems: readonly NavigationMenuItem[]
): string[] {
  const sectionIds: string[] = [];
  for (const item of sidebarMenuItems) {
    if (item.id?.startsWith("separator-")) {
      sectionIds.push(item.id.replace("separator-", ""));
    }
  }
  return sectionIds;
}
