/**
 * usePanelTitle Hook
 *
 * Derives the panel title from the current session.
 * Returns session name, task name, or default title.
 *
 * Uses `sessionByIdAtom(id)` for fine-grained subscription — only
 * re-renders when the specific session changes, not the full list.
 */
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { SESSION_CONFIG } from "@src/config/sessionCreatorConfig";
import { activeChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { type Session, sessionByIdAtom } from "@src/store/session";
import { stripPillReferences } from "@src/util/session/stripPillReferences";

export interface UsePanelTitleResult {
  /** Current session ID (null if no session) */
  currentSessionId: string | null;
  /** Derived panel title */
  panelTitle: string;
  /** Current session object (if found) */
  currentSession: Session | null;
}

interface ResolvePanelTitleInput {
  currentSessionId: string | null;
  currentSession: Pick<Session, "name" | "user_input"> | null;
  activeTabTitle?: string | null;
  defaultTitle: string;
  newSessionTitle: string;
}

export function resolvePanelTitle({
  currentSessionId,
  currentSession,
  activeTabTitle,
  defaultTitle,
  newSessionTitle,
}: ResolvePanelTitleInput): string {
  if (!currentSessionId) return newSessionTitle;
  if (!currentSession) return activeTabTitle?.trim() || defaultTitle;

  const effectiveName =
    currentSession.name &&
    currentSession.name !== SESSION_CONFIG.DEFAULT_SESSION_NAME
      ? currentSession.name
      : undefined;
  return (
    effectiveName ||
    stripPillReferences(currentSession.user_input || "") ||
    defaultTitle
  );
}

/**
 * Hook to get the current panel title based on active session
 */
export function usePanelTitle(): UsePanelTitleResult {
  const { t } = useTranslation("sessions");

  // The chat pane shows the session owned by its OWN active tab — never the
  // shared workstation/pipeline session atoms. Those atoms are a single global
  // selection observed by both surfaces: a `secondary` WorkStation ChatView
  // claiming the pipeline (or WorkStation's remembered selection) would
  // otherwise leak a session into this pane while it sits on Launchpad. Keying
  // off the active tab guarantees a live session is owned by exactly one
  // surface — so moving a chat to My Station and switching WorkStation tabs no
  // longer mistriggers the session here.
  const activeTab = useAtomValue(activeChatPanelTabAtom);
  const currentSessionId =
    activeTab?.type === "session" ? (activeTab.sessionId ?? null) : null;

  const currentSession =
    (useAtomValue(sessionByIdAtom(currentSessionId ?? "")) as
      | Session
      | undefined) ?? null;

  const defaultTitle = t("chat.defaultTitle");
  const newSessionTitle = t("chat.newSession");

  const panelTitle = useMemo(
    () =>
      resolvePanelTitle({
        currentSessionId,
        currentSession,
        activeTabTitle: activeTab?.title,
        defaultTitle,
        newSessionTitle,
      }),
    [
      activeTab?.title,
      currentSession,
      currentSessionId,
      defaultTitle,
      newSessionTitle,
    ]
  );

  return {
    currentSessionId,
    panelTitle,
    currentSession,
  };
}
