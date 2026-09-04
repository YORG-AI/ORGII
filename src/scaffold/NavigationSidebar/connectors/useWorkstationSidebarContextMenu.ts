import { type MouseEvent, useCallback } from "react";

import { dismissHoverCard } from "@src/components/SessionHoverCard/singletonStore";
import { createLogger } from "@src/hooks/logger";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { Session } from "@src/store/session";
import {
  type NativeMenuItemOptions,
  popupNativeMenu,
} from "@src/util/platform/tauri/nativeMenuPopup";
import {
  isCursorIdeSession,
  isHumanSession,
} from "@src/util/session/sessionDispatch";
import { isChatPanelTuiSessionId } from "@src/util/ui/terminal/chatPanelTuiSessionId";

import {
  getDraftIdFromMenuItemId,
  isDraftMenuItemId,
} from "./sidebarConnectorUtils";
import type { UseRenameSessionModalResult } from "./useRenameSessionModal";

const log = createLogger("WorkstationSidebar");

interface UseWorkstationSidebarContextMenuParams {
  sessionMap: Map<string, Session>;
  rename: UseRenameSessionModalResult;
  handleDeleteSession: (sessionId: string) => Promise<void>;
  handleDeleteDraft: (draftId: string) => void;
  handleOpenDraftInNewTab: (item: NavigationMenuItem) => void;
  handleExportMarkdown: (sessionId: string) => Promise<void>;
  handleOpenInNewTab: (sessionId: string) => void;
  handleOpenInNewWindow: (sessionId: string) => void;
  handleOpenInMyStation: (sessionId: string) => void;
  handleTogglePin: (sessionId: string) => Promise<void>;
  /** Owner-side share dialog gate + opener (design §6.3, M4b). */
  /** Move-to-cloud-org (session→org tag) gate + opener. */
  isMoveEligible: (session: Session) => boolean;
  handleOpenMoveToOrg: (session: Session) => void;
  moveToOrgLabel: string;
  /** Per-session cloud access ladder (§13.4) gate + opener. */
  isCloudSyncLevelEligible: (session: Session) => boolean;
  handleOpenCloudSyncLevel: (session: Session) => void;
  cloudSyncLevelLabel: string;
  /** Cloud per-session shares (0012) gate + opener. */
  isCloudShareEligible: (session: Session) => boolean;
  handleOpenCloudShare: (session: Session) => void;
  cloudShareLabel: string;
  /**
   * Copy a non-secret session reference. Gated on the session actually
   * being published to a cloud org: a reference for an org it was never
   * pushed to resolves for nobody, and the paste looks fine either way.
   */
  isCopyReferenceEligible: (session: Session) => boolean;
  handleCopyReference: (session: Session) => void;
  copyReferenceLabel: string;
  /** Team rows have no local Session and provide their own canonical menu. */
  buildCloudRemoteItemMenuItems?: (
    item: NavigationMenuItem
  ) => NativeMenuItemOptions[];
  tCommon: (key: string, defaultValue?: string) => string;
}

export function useWorkstationSidebarContextMenu({
  sessionMap,
  rename,
  handleDeleteSession,
  handleDeleteDraft,
  handleOpenDraftInNewTab,
  handleExportMarkdown,
  handleOpenInNewTab,
  handleOpenInNewWindow,
  handleOpenInMyStation,
  handleTogglePin,
  isMoveEligible,
  handleOpenMoveToOrg,
  moveToOrgLabel,
  isCloudSyncLevelEligible,
  handleOpenCloudSyncLevel,
  cloudSyncLevelLabel,
  isCloudShareEligible,
  handleOpenCloudShare,
  cloudShareLabel,
  isCopyReferenceEligible,
  handleCopyReference,
  copyReferenceLabel,
  buildCloudRemoteItemMenuItems,
  tCommon,
}: UseWorkstationSidebarContextMenuParams): (
  event: MouseEvent,
  _key: string,
  item: NavigationMenuItem
) => Promise<void> {
  const buildMenuItems = useCallback(
    (_key: string, item: NavigationMenuItem): NativeMenuItemOptions[] => {
      if (isDraftMenuItemId(item.id)) {
        const draftId = getDraftIdFromMenuItemId(item.id);
        if (!draftId) return [];
        return [
          {
            text: tCommon("actions.openInNewTab", "Open in New Tab"),
            action: () => handleOpenDraftInNewTab(item),
          },
          {
            text: tCommon("sessions:sidebar.removeDraft", "Remove draft"),
            action: () => handleDeleteDraft(draftId),
          },
        ];
      }

      if (!sessionMap.has(item.id)) {
        return buildCloudRemoteItemMenuItems?.(item) ?? [];
      }

      const isCursorIde = isCursorIdeSession(item.id);
      const session = sessionMap.get(item.id);

      // Subagent rows have no meaningful row-level actions.
      if (session?.parentSessionId || item.id.includes(":subagent:")) return [];

      const openInNewTabItem: NativeMenuItemOptions = {
        text: tCommon("actions.openInNewTab", "Open in New Tab"),
        action: () => handleOpenInNewTab(item.id),
      };
      const openInNewWindowItem: NativeMenuItemOptions = {
        text: tCommon("actions.openInNewWindow", "Open in New Window"),
        action: () => handleOpenInNewWindow(item.id),
      };
      const openInMyStationItem: NativeMenuItemOptions = {
        text: tCommon(
          "sessions:controlTower.sidebar.openInMyStation",
          "Open in My Station"
        ),
        action: () => handleOpenInMyStation(item.id),
      };
      const pinItem: NativeMenuItemOptions = {
        text: session?.pinned
          ? tCommon("sessions:chat.unpinSession", "Unpin")
          : tCommon("sessions:chat.pinSession", "Pin"),
        action: () => handleTogglePin(item.id),
      };

      if (isCursorIde) {
        return [
          openInNewTabItem,
          openInNewWindowItem,
          openInMyStationItem,
          pinItem,
        ];
      }

      const deleteItem: NativeMenuItemOptions = {
        text: tCommon("actions.delete"),
        action: () => handleDeleteSession(item.id),
      };
      if (isChatPanelTuiSessionId(item.id)) {
        return [openInNewTabItem, openInNewWindowItem, pinItem, deleteItem];
      }

      const primaryItems: NativeMenuItemOptions[] = [
        openInNewTabItem,
        openInNewWindowItem,
        openInMyStationItem,
        {
          text: tCommon("actions.rename"),
          action: () => rename.open(item.id, sessionMap),
        },
      ];
      if (!isHumanSession(item.id)) {
        primaryItems.push({
          text: tCommon("sessions:chat.exportAsMarkdown", "Export as Markdown"),
          action: () => handleExportMarkdown(item.id),
        });
      }
      // Move (tag) the session into a managed cloud org, independent of
      // repo-scope auto-sharing. Owner's own pushable sessions only.
      if (session && isMoveEligible(session)) {
        primaryItems.push({
          text: moveToOrgLabel,
          action: () => handleOpenMoveToOrg(session),
        });
      }
      // Per-session cloud access ladder (§13.4): Off / Metadata only /
      // Full replay + org/restricted visibility, per cloud org.
      if (session && isCloudSyncLevelEligible(session)) {
        primaryItems.push({
          text: cloudSyncLevelLabel,
          action: () => handleOpenCloudSyncLevel(session),
        });
      }
      // Cloud per-session shares (0012): directed member grants + guest
      // link shares, for the owner's own cloud-synced sessions.
      if (session && isCloudShareEligible(session)) {
        primaryItems.push({
          text: cloudShareLabel,
          action: () => handleOpenCloudShare(session),
        });
      }
      // Non-secret reference for issue trackers and PRs. Sits beside the
      // sharing actions because it is only meaningful once shared.
      if (session && isCopyReferenceEligible(session)) {
        primaryItems.push({
          text: copyReferenceLabel,
          action: () => handleCopyReference(session),
        });
      }

      return [...primaryItems, pinItem, { item: "Separator" }, deleteItem];
    },
    [
      sessionMap,
      tCommon,
      rename,
      handleDeleteSession,
      handleDeleteDraft,
      handleOpenDraftInNewTab,
      handleExportMarkdown,
      handleOpenInNewTab,
      handleOpenInNewWindow,
      handleOpenInMyStation,
      handleTogglePin,
      handleOpenMoveToOrg,
      isMoveEligible,
      moveToOrgLabel,
      handleOpenCloudSyncLevel,
      isCloudSyncLevelEligible,
      cloudSyncLevelLabel,
      handleOpenCloudShare,
      isCloudShareEligible,
      cloudShareLabel,
      handleCopyReference,
      isCopyReferenceEligible,
      copyReferenceLabel,
      buildCloudRemoteItemMenuItems,
    ]
  );

  return useCallback(
    async (event: MouseEvent, key: string, item: NavigationMenuItem) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        dismissHoverCard();
        await popupNativeMenu({
          source: "workstation-sidebar-row",
          buildItems: () => buildMenuItems(key, item),
        });
      } catch (error) {
        log.error("[WorkstationSidebar] Context menu failed:", error);
      }
    },
    [buildMenuItems]
  );
}
