/**
 * useNativeSessionStatusMonitor
 *
 * Listens for the "session-status-changed" Tauri event emitted by
 * `agent_core/lifecycle.rs` when a native (Rust) session reaches a terminal
 * state (completed / failed / cancelled).
 *
 * The event fires for ALL sessions regardless of which is active in the UI,
 * so this hook keeps `sessionsAtom` current for background sessions that the
 * user is not actively viewing — e.g. sessions launched from another window
 * whose TaskCard status should reflect the live state.
 *
 * Also listens for "session-account-switched" (the single backend
 * chokepoint event for EVERY account-switch path: session_patch, message
 * override sync, channel switch, CLI follow-up) so cross-window or
 * backend-initiated switches reach `sessionsAtom` without relying on the
 * initiating window's optimistic update.
 *
 * It also owns transition-based native notifications. Foreground turns may
 * play sound, while sessions outside user attention may additionally raise
 * system notifications or quiet-hours summaries.
 */
import { listen } from "@tauri-apps/api/event";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import {
  isNotificationAttentionRequired,
  isSuccessfulNotificationTurnStatus,
} from "@src/api/services/notificationPolicy";
import {
  markTurnRunning,
  markTurnTerminal,
  toTurnTerminalStatus,
} from "@src/engines/SessionCore/control/turnLifecycle";
import {
  toCliSessionStatus,
  toSessionListStatus,
} from "@src/engines/SessionCore/sync/sessionSyncUtils";
import {
  deliverSessionTerminalNotification,
  shouldDeliverSessionTerminalNotification,
} from "@src/hooks/session/sessionTerminalNotifications";
import {
  activeSessionIdAtom,
  sessionByIdAtom,
  updateSessionStatus,
} from "@src/store/session";
import { notificationSettingsAtom } from "@src/store/ui/notificationAtom";
import { isTerminalStatus } from "@src/types/session/session";
import {
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";
import { isSessionRuntimeExecuting } from "@src/util/session/sessionRuntimeExecuting";

interface SessionStatusChangedPayload {
  sessionId: string;
  status: string;
}

interface SessionAccountSwitchedPayload {
  sessionId: string;
  fromAccountId: string | null;
  toAccountId: string;
  model: string | null;
}

interface SessionRenamedPayload {
  sessionId: string;
  name: string;
}

export function useNativeSessionStatusMonitor(): void {
  const { t } = useTranslation();
  const notificationSettings = useAtomValue(notificationSettingsAtom);
  const activeSessionId = useAtomValue(activeSessionIdAtom);
  const settingsRef = useRef(notificationSettings);
  const translationRef = useRef(t);
  const activeSessionIdRef = useRef(activeSessionId);

  useEffect(() => {
    settingsRef.current = notificationSettings;
  }, [notificationSettings]);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    translationRef.current = t;
  }, [t]);

  useEffect(() => {
    const unlistenPromise = listen<SessionStatusChangedPayload>(
      "session-status-changed",
      (event) => {
        const { sessionId, status } = event.payload;
        const completedTurn = isSuccessfulNotificationTurnStatus(status);
        const session = isStoreInitialized()
          ? getInstrumentedStore().get(sessionByIdAtom(sessionId))
          : undefined;
        if (completedTurn) {
          markTurnTerminal(sessionId, "completed");
        } else if (isTerminalStatus(status)) {
          markTurnTerminal(sessionId, toTurnTerminalStatus(status));
        } else if (isSessionRuntimeExecuting(status)) {
          markTurnRunning(sessionId);
        }

        const completedBoundary =
          completedTurn &&
          !isSuccessfulNotificationTurnStatus(session?.status ?? "");
        const notificationBoundary =
          completedBoundary ||
          shouldDeliverSessionTerminalNotification(session?.status, status);
        if (session && notificationBoundary) {
          const outsideActiveSession =
            session.background === true ||
            activeSessionIdRef.current !== sessionId;
          deliverSessionTerminalNotification(
            {
              sessionId,
              status: completedBoundary ? "completed" : status,
              sessionName:
                session.name ||
                translationRef.current("notifications.backgroundSession"),
              attentionRequired:
                isNotificationAttentionRequired(outsideActiveSession),
              errorMessage: session.error_message,
            },
            settingsRef.current,
            translationRef.current
          );
        }
        // `status` is the raw wire string off the Tauri event payload and is
        // written straight into the session-list row that drives sidebar
        // grouping, Kanban lanes and every terminal-status predicate. Narrow
        // it against the Rust enum mirror, then map it onto `SessionStatus`,
        // instead of laundering it through `as SessionStatus`.
        updateSessionStatus(
          sessionId,
          toSessionListStatus(toCliSessionStatus(status))
        );
      }
    );

    const unlistenRenamePromise = listen<SessionRenamedPayload>(
      "session-renamed",
      (event) => {
        const { sessionId, name } = event.payload;
        void (async () => {
          const [{ getInstrumentedStore }, { sessionByIdAtom, upsertSession }] =
            await Promise.all([
              import("@src/util/core/state/instrumentedStore"),
              import("@src/store/session"),
            ]);
          const store = getInstrumentedStore();
          const before = store.get(sessionByIdAtom(sessionId));
          if (!before || before.name === name) return;
          upsertSession({ ...before, name });
        })();
      }
    );

    const unlistenAccountPromise = listen<SessionAccountSwitchedPayload>(
      "session-account-switched",
      (event) => {
        const { sessionId, toAccountId, model } = event.payload;
        void (async () => {
          const [{ getInstrumentedStore }, { sessionByIdAtom, upsertSession }] =
            await Promise.all([
              import("@src/util/core/state/instrumentedStore"),
              import("@src/store/session"),
            ]);
          const store = getInstrumentedStore();
          const before = store.get(sessionByIdAtom(sessionId));
          // Unknown session (not yet loaded in this window) — the next
          // full session-list sync will carry the new account anyway.
          if (!before) return;
          if (
            before.accountId === toAccountId &&
            (model == null || before.model === model)
          )
            return;
          upsertSession({
            ...before,
            accountId: toAccountId,
            ...(model != null ? { model } : {}),
          });
        })();
      }
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
      unlistenRenamePromise.then((unlisten) => unlisten());
      unlistenAccountPromise.then((unlisten) => unlisten());
    };
  }, []);
}
