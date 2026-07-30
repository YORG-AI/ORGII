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
 * This also owns terminal notifications for native background sessions.
 * Delivery is transition-based so repeated native events and hydrated
 * historical terminal state cannot replay notifications.
 */
import { listen } from "@tauri-apps/api/event";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import {
  markTurnRunning,
  markTurnTerminal,
  toTurnTerminalStatus,
} from "@src/engines/SessionCore/control/turnLifecycle";
import {
  deliverBackgroundSessionTerminalNotification,
  shouldDeliverBackgroundSessionTerminalNotification,
} from "@src/hooks/session/backgroundSessionNotifications";
import {
  type SessionStatus,
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
  const settingsRef = useRef(notificationSettings);
  const translationRef = useRef(t);

  useEffect(() => {
    settingsRef.current = notificationSettings;
  }, [notificationSettings]);
  useEffect(() => {
    translationRef.current = t;
  }, [t]);

  useEffect(() => {
    const unlistenPromise = listen<SessionStatusChangedPayload>(
      "session-status-changed",
      (event) => {
        const { sessionId, status } = event.payload;
        const session = isStoreInitialized()
          ? getInstrumentedStore().get(sessionByIdAtom(sessionId))
          : undefined;
        if (isTerminalStatus(status)) {
          markTurnTerminal(sessionId, toTurnTerminalStatus(status));
          if (
            session &&
            shouldDeliverBackgroundSessionTerminalNotification(
              session.status,
              status,
              session.background === true
            )
          ) {
            deliverBackgroundSessionTerminalNotification(
              {
                status,
                sessionName:
                  session.name ||
                  translationRef.current("notifications.backgroundSession"),
                errorMessage: session.error_message,
              },
              settingsRef.current,
              translationRef.current
            );
          }
        } else if (isSessionRuntimeExecuting(status)) {
          markTurnRunning(sessionId);
        }
        updateSessionStatus(sessionId, status as SessionStatus);
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
