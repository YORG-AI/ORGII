import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useAtomValue, useSetAtom } from "jotai";
import { type Dispatch, type SetStateAction, useCallback } from "react";

import { deleteSession } from "@src/api/tauri/agent";
import { benchmarkApi } from "@src/api/tauri/benchmark";
import { rpc } from "@src/api/tauri/rpc";
import Message from "@src/components/Message";
import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { ensureFreshSession } from "@src/features/Org2Cloud/org2CloudClient";
import {
  buildCloudOrgSelectorValue,
  org2CloudOrgsAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import {
  deleteSession as deleteCloudSession,
  isOrg2SyncErrorCode,
} from "@src/features/Org2Cloud/org2CloudSyncClient";
import { org2CloudSyncEngine } from "@src/features/Org2Cloud/org2CloudSyncEngine";
import {
  getSessionForkedFrom,
  removeForkRelayEntry,
} from "@src/features/TeamCollaboration/forkSession";
import {
  isSessionTaggedToCloudOrg,
  sessionOrgTagsAtom,
} from "@src/features/TeamCollaboration/sessionOrgTagsAtom";
import { clearCliTurnLifecycleSession } from "@src/hooks/cliSession/cliTurnLifecycleCoordinator";
import { createLogger } from "@src/hooks/logger";
import type { GoToNewSessionOptions } from "@src/hooks/navigation/useAppNavigation";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import {
  benchmarkActiveBatchIdAtom,
  benchmarkActiveBatchTaskIdAtom,
  benchmarkAgentBatchStatusAtom,
} from "@src/store/benchmark";
import {
  SESSION_SIDEBAR_PAGE_SIZE,
  type Session,
  type SessionListCategory,
  loadMoreCategory,
  removeSession,
  sessionPaginationAtom,
  upsertSession,
} from "@src/store/session";
import {
  CHAT_PANEL_SURFACE_KIND,
  chatPanelNavigateAtom,
} from "@src/store/ui/chatPanelAtom";
import { invokeTauri } from "@src/util/platform/tauri/init";
import { isCliSession } from "@src/util/session/sessionDispatch";
import { getSessionListDisplayName } from "@src/util/session/sessionSidebarRow";
import {
  getChatPanelTabIdFromTuiSessionId,
  isChatPanelTuiSessionId,
} from "@src/util/ui/terminal/chatPanelTuiSessionId";

import {
  NEW_SESSION_MENU_ITEM_ID,
  getDraftIdFromMenuItemId,
} from "./sidebarConnectorUtils";
import {
  isUnifiedLoadMoreId,
  loadUnifiedReadyCategories,
} from "./useSessionMenuItems/paginationHelpers";

const log = createLogger("WorkstationSidebar");

interface UseWorkstationSidebarHandlersParams {
  activeSessionId: string;
  sessionMap: Map<string, Session>;
  isLoadMoreId: (id: string) => SessionListCategory | null;
  getLoadMoreGroupId: (id: string) => string | null;
  sessionRouteLabel: string;
  goToNewSession: (options?: GoToNewSessionOptions) => void;
  navigateTo: (path: string) => void;
  openSession: (
    sessionId: string,
    sessionName?: string,
    repoPath?: string
  ) => void;
  promoteActiveSessionCreatorDraft: () => void;
  setGroupVisibleCounts: Dispatch<SetStateAction<Map<string, number>>>;
  tCommon: (key: string, defaultValue?: string) => string;
  onOpenChatPanelTab: (tabId: string) => void;
  onOpenSessionChatPanelTab: (options: {
    sessionId: string;
    sessionName?: string;
    repoPath?: string;
  }) => void;
  onCloseChatPanelTab: (tabId: string) => Promise<void>;
  /**
   * Cloud-org remote session rows (`cloudremote-<orgId>|<rowId>` ids, built
   * by cloudSessionsSection). Consulted BEFORE the sessionMap fallback —
   * these rows have no local Session yet. Returns true when handled.
   */
  onCloudRemoteItemClick?: (item: NavigationMenuItem) => boolean;
}

interface UseWorkstationSidebarHandlersResult {
  handleDeleteSession: (sessionId: string) => Promise<void>;
  handleExportMarkdown: (sessionId: string) => Promise<void>;
  handleMenuItemClick: (_key: string, item: NavigationMenuItem) => void;
  handleTogglePin: (sessionId: string) => Promise<void>;
}

export function useWorkstationSidebarHandlers({
  activeSessionId,
  sessionMap,
  isLoadMoreId,
  getLoadMoreGroupId,
  sessionRouteLabel,
  goToNewSession,
  navigateTo,
  openSession,
  promoteActiveSessionCreatorDraft,
  setGroupVisibleCounts,
  tCommon,
  onOpenChatPanelTab,
  onOpenSessionChatPanelTab,
  onCloseChatPanelTab,
  onCloudRemoteItemClick,
}: UseWorkstationSidebarHandlersParams): UseWorkstationSidebarHandlersResult {
  const navigateChatPanel = useSetAtom(chatPanelNavigateAtom);
  const setBenchmarkAgentBatchStatus = useSetAtom(
    benchmarkAgentBatchStatusAtom
  );
  const setBenchmarkActiveBatchId = useSetAtom(benchmarkActiveBatchIdAtom);
  const setBenchmarkActiveBatchTaskId = useSetAtom(
    benchmarkActiveBatchTaskIdAtom
  );
  const pagination = useAtomValue(sessionPaginationAtom);
  const cloudAuth = useAtomValue(org2CloudAuthAtom);
  const setCloudAuth = useSetAtom(org2CloudAuthAtom);
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const sessionOrgTags = useAtomValue(sessionOrgTagsAtom);
  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      try {
        if (isChatPanelTuiSessionId(sessionId)) {
          const tabId = getChatPanelTabIdFromTuiSessionId(sessionId);
          if (tabId) await onCloseChatPanelTab(tabId);
          return;
        }
        const session = sessionMap.get(sessionId);
        const forkedFrom = session ? getSessionForkedFrom(session) : undefined;
        // Cloud retraction targets, mirroring the engine's publish targets:
        // a fork publishes only to its source org; an ordinary session
        // publishes to orgs it is explicitly owned by or Move-tagged to.
        // Owner delete = retract everywhere it was published — a local-only
        // delete would leave a ghost row every teammate still sees.
        const cloudTargetOrgIds = forkedFrom
          ? [forkedFrom.orgId]
          : session
            ? cloudOrgs
                .filter(
                  (org) =>
                    session.orgId === buildCloudOrgSelectorValue(org.orgId) ||
                    isSessionTaggedToCloudOrg(
                      sessionOrgTags,
                      sessionId,
                      org.orgId
                    )
                )
                .map((org) => org.orgId)
            : [];
        if (cloudTargetOrgIds.length > 0) {
          const fresh = cloudAuth ? await ensureFreshSession(cloudAuth) : null;
          if (!fresh || !cloudAuth) {
            throw new Error("Cannot retract cloud session without cloud auth");
          }
          commitRefreshedAuth(setCloudAuth, cloudAuth, fresh);
          for (const orgId of cloudTargetOrgIds) {
            try {
              await deleteCloudSession(fresh.accessToken, orgId, sessionId);
            } catch (error) {
              // Never pushed (or already tombstoned) — nothing to retract.
              if (!isOrg2SyncErrorCode(error, "ORG2_SESSION_NOT_FOUND")) {
                throw error;
              }
            }
            org2CloudSyncEngine.invalidatePushedMetadataHash(orgId, sessionId);
          }
        }
        if (isCliSession(sessionId)) {
          await invokeTauri("cli_agent_delete", { sessionId });
          clearCliTurnLifecycleSession(sessionId);
        } else {
          await deleteSession(sessionId);
        }
        removeSession(sessionId);
        removeForkRelayEntry(sessionId);

        if (sessionId === activeSessionId) {
          goToNewSession();
        }
      } catch (error) {
        log.error("[WorkstationSidebar] Failed to delete session:", error);
        Message.error(tCommon("sessions:chat.failedToDeleteSession"));
      }
    },
    [
      activeSessionId,
      cloudAuth,
      setCloudAuth,
      cloudOrgs,
      goToNewSession,
      onCloseChatPanelTab,
      sessionMap,
      sessionOrgTags,
      tCommon,
    ]
  );

  const handleExportMarkdown = useCallback(
    async (sessionId: string) => {
      try {
        const session = sessionMap.get(sessionId);
        const baseName =
          session?.name ||
          (session
            ? getSessionListDisplayName(session, sessionRouteLabel)
            : sessionRouteLabel);
        const suggestedName = `${baseName.replace(/[/\\?%*:|"<>]/g, "-").slice(0, 60)}.md`;

        const filePath = await saveDialog({
          defaultPath: suggestedName,
          filters: [{ name: "Markdown", extensions: ["md"] }],
        });
        if (!filePath) return;

        const markdown = await rpc.sessionCore.eventStore.exportMarkdown({
          sessionId,
        });
        await writeTextFile(filePath, markdown);
        Message.success(tCommon("sessions:chat.exportSuccess", "Exported!"));
      } catch (error) {
        log.error("[WorkstationSidebar] Export markdown failed:", error);
        Message.error(tCommon("sessions:chat.exportFailed", "Export failed"));
      }
    },
    [sessionMap, sessionRouteLabel, tCommon]
  );

  const handleMenuItemClick = useCallback(
    (_key: string, item: NavigationMenuItem) => {
      if (item.id === NEW_SESSION_MENU_ITEM_ID) {
        goToNewSession();
        return;
      }

      const draftId = getDraftIdFromMenuItemId(item.id);
      if (draftId) {
        goToNewSession({ draftId });
        return;
      }

      if (item.routePath) {
        navigateTo(item.routePath);
        return;
      }

      if (isUnifiedLoadMoreId(item.id)) {
        void loadUnifiedReadyCategories({
          disabled: item.disabled,
          pagination,
          loadCategory: loadMoreCategoryAction,
        });
        return;
      }

      const loadMoreGroupId = getLoadMoreGroupId(item.id);
      if (loadMoreGroupId) {
        setGroupVisibleCounts((previousCounts) => {
          const nextCounts = new Map(previousCounts);
          const current =
            nextCounts.get(loadMoreGroupId) ?? SESSION_SIDEBAR_PAGE_SIZE;
          nextCounts.set(loadMoreGroupId, current + SESSION_SIDEBAR_PAGE_SIZE);
          return nextCounts;
        });
        return;
      }

      const loadMoreCategory = isLoadMoreId(item.id);
      if (loadMoreCategory) {
        void loadMoreCategoryAction(loadMoreCategory);
        return;
      }

      if (isChatPanelTuiSessionId(item.id)) {
        const tabId = getChatPanelTabIdFromTuiSessionId(item.id);
        if (tabId) {
          navigateChatPanel({ kind: CHAT_PANEL_SURFACE_KIND.SESSION });
          onOpenChatPanelTab(tabId);
        }
        return;
      }

      // Teammate rows in the cloud "Team sessions" section import remotely —
      // resolve them before the local sessionMap fallback.
      if (onCloudRemoteItemClick?.(item)) return;

      const originalSession = sessionMap.get(item.id);
      if (!originalSession) return;

      const sessionName = getSessionListDisplayName(
        originalSession,
        sessionRouteLabel
      );

      if (isBenchmarkCoordinatorSession(originalSession)) {
        navigateChatPanel({
          kind: CHAT_PANEL_SURFACE_KIND.BENCHMARK_SESSION_GROUP,
        });
        promoteActiveSessionCreatorDraft();
        void benchmarkApi
          .listAgentBatchHistories({ limit: 100 })
          .then((histories) =>
            histories.find((history) => history.masterSessionId === item.id)
          )
          .then((history) => {
            if (!history) return;
            setBenchmarkAgentBatchStatus(history);
            setBenchmarkActiveBatchId(history.batchId);
            setBenchmarkActiveBatchTaskId(null);
          });
        openSession(item.id, sessionName, originalSession.repoPath);
        return;
      }

      navigateChatPanel({ kind: CHAT_PANEL_SURFACE_KIND.SESSION });
      promoteActiveSessionCreatorDraft();
      onOpenSessionChatPanelTab({
        sessionId: item.id,
        sessionName,
        repoPath: originalSession.repoPath,
      });
      openSession(item.id, sessionName, originalSession.repoPath);
    },
    [
      getLoadMoreGroupId,
      isLoadMoreId,
      pagination,
      sessionMap,
      openSession,
      goToNewSession,
      navigateChatPanel,
      navigateTo,
      onCloudRemoteItemClick,
      onOpenChatPanelTab,
      onOpenSessionChatPanelTab,
      promoteActiveSessionCreatorDraft,
      sessionRouteLabel,
      setBenchmarkActiveBatchId,
      setBenchmarkActiveBatchTaskId,
      setBenchmarkAgentBatchStatus,
      setGroupVisibleCounts,
    ]
  );

  const handleTogglePin = useCallback(
    async (sessionId: string) => {
      if (isChatPanelTuiSessionId(sessionId)) return;
      const session = sessionMap.get(sessionId);
      if (!session) return;
      const newPinned = !(session.pinned ?? false);
      upsertSession({ ...session, pinned: newPinned });
      try {
        await rpc.sessionAggregate.patch({
          sessionId,
          patch: { pinned: newPinned },
        });
      } catch (error) {
        upsertSession({ ...session, pinned: session.pinned ?? false });
        log.error("[WorkstationSidebar] Failed to toggle pin:", error);
      }
    },
    [sessionMap]
  );
  return {
    handleDeleteSession,
    handleExportMarkdown,
    handleMenuItemClick,
    handleTogglePin,
  };
}

function loadMoreCategoryAction(
  sessionListCategory: SessionListCategory
): Promise<void> {
  return loadMoreCategory(sessionListCategory);
}

function isBenchmarkCoordinatorSession(session: Session): boolean {
  return session.user_input?.startsWith("Benchmark run coordinator\n") ?? false;
}
