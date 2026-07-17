import { emit } from "@tauri-apps/api/event";
import type { TFunction } from "i18next";
import { type ComponentProps, useCallback, useState } from "react";

import Message from "@src/components/Message";
import CloudSessionShareDialog from "@src/features/Org2Cloud/CloudSessionShareDialog";
import { useCloudSessionShareDialog } from "@src/features/Org2Cloud/CloudSessionShareDialog/useCloudSessionShareDialog";
import { SessionImportExportModal } from "@src/scaffold/NavigationSidebar/connectors/SessionImportExportModal";
import type { Session } from "@src/store/session/sessionAtom/types";

import LinkSessionToWorkItemModal from "../panels/LinkSessionToWorkItemModal";

type ExportActiveSession = ComponentProps<
  typeof SessionImportExportModal
>["activeSession"];

interface UseChatPanelSessionModalsOptions {
  activeSession: ExportActiveSession;
  closeHeaderActionsMenu: () => void;
  /** Full session row for the share dialog (design §6.3 header mount). */
  currentSession: Session | null;
  currentSessionId: string | null;
  t: TFunction<["sessions", "common", "projects", "navigation"]>;
}

export function useChatPanelSessionModals({
  activeSession,
  closeHeaderActionsMenu,
  currentSession,
  currentSessionId,
  t,
}: UseChatPanelSessionModalsOptions) {
  const [isExportModalOpen, setExportModalOpen] = useState(false);
  const [isLinkWorkItemModalOpen, setLinkWorkItemModalOpen] = useState(false);
  const cloudShare = useCloudSessionShareDialog();

  const handleOpenExportSessionJson = useCallback(() => {
    setExportModalOpen(true);
    closeHeaderActionsMenu();
  }, [closeHeaderActionsMenu]);

  const handleCloseExportSessionJson = useCallback(() => {
    setExportModalOpen(false);
  }, []);

  const handleOpenLinkWorkItem = useCallback(() => {
    if (!currentSessionId) {
      Message.warning(t("common:toasts.openSessionBeforeLinking"));
      return;
    }
    setLinkWorkItemModalOpen(true);
    closeHeaderActionsMenu();
  }, [closeHeaderActionsMenu, currentSessionId, t]);

  const handleCloseLinkWorkItem = useCallback(() => {
    setLinkWorkItemModalOpen(false);
  }, []);

  const handleSessionLinkedToWorkItem = useCallback(() => {
    void emit("orgii-data-changed", new Date().toISOString());
  }, []);

  // Cloud share dialog (0012), session-header mount: only for the
  // owner's own pushable session that belongs to ≥1 cloud org.
  const showCloudShareSettings = Boolean(
    currentSession && cloudShare.isCloudShareEligible(currentSession)
  );

  const handleOpenCloudShareSettings = useCallback(() => {
    if (!currentSession) return;
    cloudShare.openCloudShare(currentSession);
    closeHeaderActionsMenu();
  }, [closeHeaderActionsMenu, cloudShare, currentSession]);

  const sessionModals = (
    <>
      <LinkSessionToWorkItemModal
        open={isLinkWorkItemModalOpen}
        sessionId={currentSessionId ?? null}
        onClose={handleCloseLinkWorkItem}
        onLinked={handleSessionLinkedToWorkItem}
      />
      <SessionImportExportModal
        visible={isExportModalOpen}
        mode="export"
        activeSession={activeSession}
        sessionFallbackName={t("chat.defaultTitle")}
        onClose={handleCloseExportSessionJson}
        onImported={() => undefined}
      />
      <CloudSessionShareDialog
        session={cloudShare.cloudShareSession}
        orgs={cloudShare.cloudShareOrgs}
        onClose={cloudShare.closeCloudShare}
      />
    </>
  );

  return {
    handleOpenExportSessionJson,
    handleOpenLinkWorkItem,
    handleOpenCloudShareSettings,
    showCloudShareSettings,
    sessionModals,
  };
}
