import { emit } from "@tauri-apps/api/event";
import type { TFunction } from "i18next";
import {
  type ComponentProps,
  Suspense,
  lazy,
  useCallback,
  useState,
} from "react";

import Message from "@src/components/Message";
import CloudSessionShareDialog from "@src/features/Org2Cloud/CloudSessionShareDialog";
import { useCloudSessionShareDialog } from "@src/features/Org2Cloud/CloudSessionShareDialog/useCloudSessionShareDialog";
import { SessionImportExportModal } from "@src/scaffold/NavigationSidebar/connectors/SessionImportExportModal";
import type { Session } from "@src/store/session/sessionAtom/types";

import LinkSessionToWorkItemModal from "../panels/LinkSessionToWorkItemModal";

// Lazy: the raw-transcript dialog pulls CodeMirror, and it only ever mounts
// after the user picks it from the header actions menu.
const SessionRawTranscriptDialog = lazy(
  () => import("../components/SessionRawTranscriptDialog")
);

type ExportActiveSession = ComponentProps<
  typeof SessionImportExportModal
>["activeSession"];

interface UseSessionActionModalsOptions {
  activeSession: ExportActiveSession;
  closeHeaderActionsMenu: () => void;
  currentSession: Session | null;
  currentSessionId: string | null;
  t: TFunction<readonly ["sessions", "common", "projects", "navigation"]>;
}

/** Shared dialogs and menu actions for any rendered session surface. */
export function useSessionActionModals({
  activeSession,
  closeHeaderActionsMenu,
  currentSession,
  currentSessionId,
  t,
}: UseSessionActionModalsOptions) {
  const [isExportModalOpen, setExportModalOpen] = useState(false);
  const [isLinkWorkItemModalOpen, setLinkWorkItemModalOpen] = useState(false);
  const [rawTranscriptSessionId, setRawTranscriptSessionId] = useState<
    string | null
  >(null);
  const cloudShare = useCloudSessionShareDialog();

  const handleOpenExportSessionJson = useCallback(() => {
    setExportModalOpen(true);
    closeHeaderActionsMenu();
  }, [closeHeaderActionsMenu]);

  const handleOpenLinkWorkItem = useCallback(() => {
    if (!currentSessionId) {
      Message.warning(t("common:toasts.openSessionBeforeLinking"));
      return;
    }
    setLinkWorkItemModalOpen(true);
    closeHeaderActionsMenu();
  }, [closeHeaderActionsMenu, currentSessionId, t]);

  const handleOpenRawTranscript = useCallback(() => {
    if (!currentSessionId) return;
    setRawTranscriptSessionId(currentSessionId);
    closeHeaderActionsMenu();
  }, [closeHeaderActionsMenu, currentSessionId]);

  const handleSessionLinkedToWorkItem = useCallback(() => {
    void emit("orgii-data-changed", new Date().toISOString());
  }, []);

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
        sessionId={currentSessionId}
        onClose={() => setLinkWorkItemModalOpen(false)}
        onLinked={handleSessionLinkedToWorkItem}
      />
      <SessionImportExportModal
        visible={isExportModalOpen}
        mode="export"
        activeSession={activeSession}
        sessionFallbackName={t("chat.defaultTitle")}
        onClose={() => setExportModalOpen(false)}
        onImported={() => undefined}
      />
      <CloudSessionShareDialog
        session={cloudShare.cloudShareSession}
        orgs={cloudShare.cloudShareOrgs}
        onClose={cloudShare.closeCloudShare}
      />
      {rawTranscriptSessionId ? (
        <Suspense fallback={null}>
          <SessionRawTranscriptDialog
            visible
            sessionId={rawTranscriptSessionId}
            onClose={() => setRawTranscriptSessionId(null)}
          />
        </Suspense>
      ) : null}
    </>
  );

  return {
    handleOpenCloudShareSettings,
    handleOpenExportSessionJson,
    handleOpenLinkWorkItem,
    handleOpenRawTranscript,
    sessionModals,
    showCloudShareSettings,
  };
}
