/**
 * Keeps registered non-member share-link imports capability-bound.
 *
 * A guest import is deliberately durable so it survives session-list reloads,
 * but the durable replay must not outlive the share token that authorized it.
 * Guests cannot subscribe to the source org's private Realtime channels, so
 * the active replay is revalidated on a short cadence and all guest imports
 * are checked on focus / a low-frequency fallback cadence.
 */
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { deleteSession as deleteLocalSession } from "@src/api/tauri/agent";
import { deleteOrgtrackCollaborationSession } from "@src/api/tauri/lineage";
import { createLogger } from "@src/hooks/logger";
import {
  chatPanelTabsAtom,
  closeChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import { removeSession } from "@src/store/session/sessionAtom/mutations";
import { persistSessions } from "@src/store/session/sessionAtom/persistence";
import type { Session } from "@src/store/session/sessionAtom/types";
import { activeSessionIdAtom } from "@src/store/session/viewAtom";

import { classifyCloudShareResolveError } from "./cloudShareImportModel";
import { commitRefreshedAuth, org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { ensureFreshSession } from "./org2CloudClient";
import { resolvePersistedCloudShareEndpoint } from "./org2CloudShareEndpoint";
import { resolveCloudSessionShare } from "./org2CloudSharesClient";

const log = createLogger("Org2CloudGuestShareAccess");

const ACTIVE_REVALIDATE_MS = 5_000;
const ALL_REVALIDATE_MS = 60_000;

interface GuestShareCapability {
  sessionId: string;
  shareToken: string;
  shareEndpointUrl?: string;
}

export function guestShareCapabilities(
  sessions: readonly Session[]
): GuestShareCapability[] {
  return sessions.flatMap((session) => {
    const shareToken = session.importedFrom?.shareToken?.trim();
    if (!shareToken) return [];
    return [
      {
        sessionId: session.session_id,
        shareToken,
        shareEndpointUrl: session.importedFrom?.shareEndpointUrl,
      },
    ];
  });
}

export function isDefinitiveGuestShareRevocation(error: unknown): boolean {
  return classifyCloudShareResolveError(error) === "invalid";
}

/**
 * Revalidate durable guest imports and evict revoked copies immediately from
 * navigation, open tabs, persistence, and the native replay stores.
 */
export function useOrg2CloudGuestShareAccess(): void {
  const auth = useAtomValue(org2CloudAuthAtom);
  const setAuth = useSetAtom(org2CloudAuthAtom);
  const sessions = useAtomValue(sessionsAtom) as Session[];
  const activeSessionId = useAtomValue(activeSessionIdAtom) ?? "";
  const store = useStore();

  const capabilities = useMemo(
    () => guestShareCapabilities(sessions),
    [sessions]
  );
  const capabilitiesRef = useRef(capabilities);
  const authRef = useRef(auth);
  const activeSessionIdRef = useRef(activeSessionId);
  const validationInFlightRef = useRef(false);

  capabilitiesRef.current = capabilities;
  authRef.current = auth;
  activeSessionIdRef.current = activeSessionId;

  const evictCapability = useCallback(
    (revoked: GuestShareCapability) => {
      const currentSessions = store.get(sessionsAtom) as Session[];
      const revokedCopies = currentSessions.filter(
        (session) =>
          session.importedFrom?.shareToken === revoked.shareToken &&
          (session.importedFrom?.shareEndpointUrl ?? "") ===
            (revoked.shareEndpointUrl ?? "")
      );

      for (const session of revokedCopies) {
        const tabs = store
          .get(chatPanelTabsAtom)
          .tabs.filter(
            (tab) =>
              tab.type === "session" && tab.sessionId === session.session_id
          );
        for (const tab of tabs) store.set(closeChatPanelTabAtom, tab.id);

        // Remove every readable frontend/persisted projection synchronously;
        // native deletion follows best-effort so a slow IPC cannot extend the
        // revoked capability's visible lifetime.
        removeSession(session.session_id);
        void Promise.allSettled([
          deleteOrgtrackCollaborationSession(session.session_id),
          deleteLocalSession(session.session_id),
        ]).then((results) => {
          for (const result of results) {
            if (result.status === "rejected") {
              log.warn(
                "failed to delete a revoked guest replay",
                result.reason
              );
            }
          }
        });
      }

      if (revokedCopies.length > 0) {
        persistSessions(store.get(sessionsAtom) as Session[]);
      }
    },
    [store]
  );

  const validate = useCallback(
    async (scope: "active" | "all", signal?: AbortSignal): Promise<void> => {
      if (validationInFlightRef.current) return;
      const currentAuth = authRef.current;
      if (!currentAuth) return;

      const currentCapabilities = capabilitiesRef.current;
      const targets =
        scope === "all"
          ? currentCapabilities
          : currentCapabilities.filter(
              (entry) => entry.sessionId === activeSessionIdRef.current
            );
      if (targets.length === 0) return;

      validationInFlightRef.current = true;
      try {
        const fresh = await ensureFreshSession(currentAuth, {
          onRefreshRejected: () =>
            setAuth((latest) => (latest === currentAuth ? null : latest)),
        });
        if (!fresh || signal?.aborted) return;
        commitRefreshedAuth(setAuth, currentAuth, fresh);

        // Sequential checks bound request concurrency when the durable guest
        // registry contains many historical imports.
        for (const capability of targets) {
          if (signal?.aborted) return;
          try {
            const endpoint = resolvePersistedCloudShareEndpoint(
              capability.shareEndpointUrl
            );
            await resolveCloudSessionShare(
              fresh.accessToken,
              capability.shareToken,
              endpoint,
              signal
            );
          } catch (error) {
            if (!signal?.aborted && isDefinitiveGuestShareRevocation(error)) {
              evictCapability(capability);
            }
          }
        }
      } finally {
        validationInFlightRef.current = false;
      }
    },
    [evictCapability, setAuth]
  );

  const capabilityKey = capabilities
    .map(
      (entry) =>
        `${entry.sessionId}\u001f${entry.shareEndpointUrl ?? ""}\u001f${entry.shareToken}`
    )
    .join("\u001e");
  const isAuthenticated = auth !== null;

  useEffect(() => {
    if (!isAuthenticated || capabilities.length === 0) return undefined;
    const abortController = new AbortController();
    const runAll = () => void validate("all", abortController.signal);
    const runActive = () => void validate("active", abortController.signal);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") runAll();
    };

    runAll();
    const activeTimer = window.setInterval(runActive, ACTIVE_REVALIDATE_MS);
    const allTimer = window.setInterval(runAll, ALL_REVALIDATE_MS);
    window.addEventListener("focus", runAll);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      abortController.abort();
      window.clearInterval(activeTimer);
      window.clearInterval(allTimer);
      window.removeEventListener("focus", runAll);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [capabilityKey, capabilities.length, isAuthenticated, validate]);
}
