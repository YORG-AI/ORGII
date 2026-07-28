/**
 * Keeps registered non-member share-link imports capability-bound.
 *
 * A guest import is deliberately durable so it survives session-list reloads,
 * but the durable replay must not outlive the share token that authorized it.
 * Guests cannot subscribe to the source org's private Realtime channels, so
 * capabilities are revalidated on concrete lifecycle events: import registry
 * changes, opening a guest replay, and focus/visibility recovery. There is no
 * periodic permission polling.
 */
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { deleteSession as deleteLocalSession } from "@src/api/tauri/agent";
import { deleteOrgtrackCollaborationSession } from "@src/api/tauri/lineage";
import { createLogger } from "@src/hooks/logger";
import {
  activeChatPanelTabAtom,
  chatPanelTabsAtom,
  closeChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import { removeSession } from "@src/store/session/sessionAtom/mutations";
import { persistSessions } from "@src/store/session/sessionAtom/persistence";
import type { Session } from "@src/store/session/sessionAtom/types";

import { classifyCloudShareResolveError } from "./cloudShareImportModel";
import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "./org2CloudAuthAtom";
import { ensureFreshSession } from "./org2CloudClient";
import {
  requireCloudShareAuthEndpoint,
  resolvePersistedCloudShareEndpoint,
} from "./org2CloudShareEndpoint";
import { resolveCloudSessionShare } from "./org2CloudSharesClient";

const log = createLogger("Org2CloudGuestShareAccess");

interface GuestShareCapability {
  sessionId: string;
  shareToken: string;
  shareEndpointUrl?: string;
}

interface GuestShareValidationFlight {
  signal?: AbortSignal;
  promise: Promise<void>;
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
  const activeTab = useAtomValue(activeChatPanelTabAtom);
  const activeSessionId =
    activeTab?.type === "session" ? (activeTab.sessionId ?? "") : "";
  const store = useStore();

  const capabilities = useMemo(
    () => guestShareCapabilities(sessions),
    [sessions]
  );
  const capabilitiesRef = useRef(capabilities);
  const authRef = useRef(auth);
  const activeSessionIdRef = useRef(activeSessionId);
  const validationInFlightRef = useRef<GuestShareValidationFlight | null>(null);

  useEffect(() => {
    capabilitiesRef.current = capabilities;
  }, [capabilities]);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

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
    async (scope: "active" | "all", signal?: AbortSignal): Promise<boolean> => {
      const activeFlight = validationInFlightRef.current;
      if (activeFlight && !activeFlight.signal?.aborted) return false;
      const currentAuth = authRef.current;
      if (!currentAuth) return false;

      const currentCapabilities = capabilitiesRef.current;
      const targets =
        scope === "all"
          ? currentCapabilities
          : currentCapabilities.filter(
              (entry) => entry.sessionId === activeSessionIdRef.current
            );
      if (targets.length === 0) return false;

      const flight: GuestShareValidationFlight = {
        signal,
        promise: Promise.resolve(),
      };
      flight.promise = (async () => {
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
            const endpoint = requireCloudShareAuthEndpoint(
              resolvePersistedCloudShareEndpoint(capability.shareEndpointUrl),
              fresh.supabaseUrl
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
      })().finally(() => {
        if (validationInFlightRef.current === flight) {
          validationInFlightRef.current = null;
        }
      });
      validationInFlightRef.current = flight;
      await flight.promise;
      return true;
    },
    [evictCapability, setAuth]
  );

  const capabilityKey = capabilities
    .map(
      (entry) =>
        `${entry.sessionId}\u001f${entry.shareEndpointUrl ?? ""}\u001f${entry.shareToken}`
    )
    .join("\u001e");
  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;

  useEffect(() => {
    if (!authIdentityKey || capabilities.length === 0) return undefined;
    const abortController = new AbortController();
    const isVisible = () => document.visibilityState !== "hidden";
    const runAll = () => {
      if (!isVisible()) return;
      void validate("all", abortController.signal);
    };
    const onVisibilityChange = () => {
      if (isVisible()) runAll();
    };

    runAll();
    window.addEventListener("focus", runAll);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      abortController.abort();
      window.removeEventListener("focus", runAll);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [authIdentityKey, capabilityKey, capabilities.length, validate]);

  useEffect(() => {
    if (!authIdentityKey || !activeSessionId || capabilities.length === 0) {
      return undefined;
    }
    const abortController = new AbortController();
    void validate("active", abortController.signal);
    return () => abortController.abort();
  }, [
    activeSessionId,
    authIdentityKey,
    capabilityKey,
    capabilities.length,
    validate,
  ]);
}
