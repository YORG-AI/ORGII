/**
 * Type surface for `useCloudSessionsSection` (see `cloudSessionsSection.tsx`).
 * Split out so sibling extraction modules can depend on the param/result
 * shapes without importing the hook implementation itself.
 */
import type React from "react";

import type { CloudSessionFilter } from "@src/features/Org2Cloud/cloudSessionFilter";
import type { Org2CloudPresenceEntry } from "@src/features/Org2Cloud/org2CloudPresenceAtom";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import type { Session } from "@src/store/session";
import type { NativeMenuItemOptions } from "@src/util/platform/tauri/nativeMenuPopup";

type CloudSessionOpenDestination = "new-tab" | "my-station";

interface CloudSessionDestinationOptions {
  sessionId: string;
  title: string;
}

export interface UseCloudSessionsSectionParams {
  /** Active cloud org id (bare, not `cloud:`-prefixed); null ⇒ no section. */
  orgId: string | null;
  sessions: readonly Session[];
  /** Active Team-sessions filter (all, directed-to-me, or one owner). */
  filter: CloudSessionFilter;
  /** Active session surface key, including a replay parked before download. */
  activeSessionId: string;
  /** Demand bound for exact local hydration in the My Conversations section. */
  localSessionHydrationLimit: number;
  /** One exact Team Session row temporarily revealed by cross-surface nav. */
  revealedMenuItemId?: string;
  /** Places an imported/local Team Conversation on the requested surface. */
  openSessionAtDestination: (
    destination: CloudSessionOpenDestination,
    options: CloudSessionDestinationOptions
  ) => void;
  onFilterChange: (filter: CloudSessionFilter) => void;
}

export interface UseCloudSessionsSectionResult {
  /** Separator + thread rows; empty when no cloud scope is active. */
  cloudMenuItems: NavigationMenuItem[];
  /** Local session ids to hide from the flat "My Sessions" list. */
  cloudFlatListExcludedSessionIds: ReadonlySet<string>;
  /** Local-origin cloud row ids that belong in the active My section. */
  cloudLocalSessionIds: ReadonlySet<string>;
  /** Cloud row key corresponding to the active replay/import surface. */
  selectedCloudMenuItemId: string | null;
  /** Click resolver for Team rows and the Team section's pagination row. */
  handleCloudSessionItemClick: (item: NavigationMenuItem) => boolean;
  /** Forget any extra Team rows revealed with Load more. */
  resetCloudTeamPagination: () => void;
  /** Canonical Team Conversation menu shared by secondary-click and ellipsis. */
  buildCloudRemoteItemMenuItems: (
    item: NavigationMenuItem
  ) => NativeMenuItemOptions[];
  /** Member-filter dropdown portal — render once next to the sidebar. */
  cloudMemberFilterDropdown: React.ReactNode;
  /**
   * Teammate row metadata keyed by `cloudremote-` menu item id — feeds the
   * sidebar hover card (local "mine" rows use the session-store card instead).
   */
  cloudRemoteRowMap: ReadonlyMap<string, RemoteTeammateSessionMetadata>;
  /** Live viewers keyed by the cloud row id used to render its hover card. */
  cloudRemoteViewerMap: ReadonlyMap<string, readonly Org2CloudPresenceEntry[]>;
}

export interface MemberFilterMenuState {
  top: number;
  left: number;
}
