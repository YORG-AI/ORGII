import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import { createLogger } from "@src/hooks/logger";
import { type Session, upsertSession } from "@src/store/session";
import { getSessionListDisplayName } from "@src/util/session/sessionSidebarRow";

const log = createLogger("WorkstationSidebar");

export interface UseRenameSessionModalResult {
  visible: boolean;
  currentName: string;
  loading: boolean;
  open: (sessionId: string, sessionMap: ReadonlyMap<string, Session>) => void;
  onConfirm: (
    newName: string,
    sessionMap: ReadonlyMap<string, Session>
  ) => Promise<void>;
  onCancel: () => void;
  renameSessionId: string | null;
}

export function useRenameSessionModal(): UseRenameSessionModalResult {
  const { t } = useTranslation("navigation");

  const [visible, setVisible] = useState(false);
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [currentName, setCurrentName] = useState("");
  const [loading, setLoading] = useState(false);

  const untitledSession = t("sidebar.defaults.untitledSession");

  const open = useCallback(
    (sessionId: string, sessionMap: ReadonlyMap<string, Session>) => {
      const session = sessionMap.get(sessionId);
      const name = session
        ? getSessionListDisplayName(session, untitledSession)
        : untitledSession;
      setRenameSessionId(sessionId);
      setCurrentName(name);
      setVisible(true);
    },
    [untitledSession]
  );

  const onConfirm = useCallback(
    async (newName: string, sessionMap: ReadonlyMap<string, Session>) => {
      if (!renameSessionId) return;
      const existing = sessionMap.get(renameSessionId);
      if (!existing) return;

      setLoading(true);
      try {
        upsertSession({ ...existing, name: newName });
        await rpc.sessionAggregate.patch({
          sessionId: renameSessionId,
          patch: { name: newName },
        });
        setVisible(false);
      } catch (error) {
        upsertSession(existing);
        log.error("Failed to rename session:", error);
      } finally {
        setLoading(false);
      }
    },
    [renameSessionId]
  );

  const onCancel = useCallback(() => {
    setVisible(false);
    setRenameSessionId(null);
    setCurrentName("");
  }, []);

  return {
    visible,
    currentName,
    loading,
    open,
    onConfirm,
    onCancel,
    renameSessionId,
  };
}
