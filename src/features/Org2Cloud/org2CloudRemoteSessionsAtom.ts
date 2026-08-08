/**
 * Per-cloud-org remote session rows for the sidebar (in-memory only).
 *
 * Maps orgId → the org's retention-windowed `cloud_list_org_sessions` rows
 * plus fetch state. Fetched lazily by `useCloudOrgRemoteSessions` when the
 * sidebar's active scope is that cloud org, then refreshed only by concrete
 * invalidations, foreground recovery, or the explicit refresh action.
 * NOT persisted — retention filtering is server-side and reconnect recovery
 * replaces the snapshot.
 */
import {
  atom,
  createStore,
  useAtom,
  useAtomValue,
  useSetAtom,
  useStore,
} from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";

import { createLogger } from "@src/hooks/logger";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "./org2CloudAuthAtom";
import { ensureFreshSession } from "./org2CloudClient";
import { FOCUS_REFRESH_COOLDOWN_MS } from "./org2CloudRealtimeRecovery";
import { listOrgSessions } from "./org2CloudSyncClient";

const log = createLogger("Org2CloudRemoteSessions");

const REMOTE_SESSIONS_CURSOR_OVERLAP_MS = 2_000;
export const MAX_REMOTE_SESSION_CACHE_ENTRIES = 64;
export const MAX_REMOTE_SESSIONS_VERSION_KEYS = 64;

type JotaiStore = ReturnType<typeof createStore>;
interface RemoteSessionsRequestState {
  inFlightKeys: Set<string>;
  lastFetchedVersionByKey: Map<string, number>;
  lastFullRefreshVersionByKey: Map<string, number>;
  activeIdentityKey: string | null;
}
const requestStateByStore = new WeakMap<
  JotaiStore,
  RemoteSessionsRequestState
>();

function requestStateFor(store: JotaiStore): RemoteSessionsRequestState {
  let state = requestStateByStore.get(store);
  if (!state) {
    state = {
      inFlightKeys: new Set<string>(),
      lastFetchedVersionByKey: new Map<string, number>(),
      lastFullRefreshVersionByKey: new Map<string, number>(),
      activeIdentityKey: null,
    };
    requestStateByStore.set(store, state);
  }
  return state;
}

export function rememberRemoteSessionsFetchedVersion(
  versions: Map<string, number>,
  key: string,
  version: number
): void {
  versions.delete(key);
  versions.set(key, version);
  while (versions.size > MAX_REMOTE_SESSIONS_VERSION_KEYS) {
    const oldest = versions.keys().next().value as string | undefined;
    if (!oldest) break;
    versions.delete(oldest);
  }
}

export function writeRemoteSessionsEntry(
  entries: Record<string, CloudOrgRemoteSessionsEntry>,
  orgId: string,
  entry: CloudOrgRemoteSessionsEntry
): Record<string, CloudOrgRemoteSessionsEntry> {
  const next = { ...entries };
  delete next[orgId];
  next[orgId] = entry;
  const orgIds = Object.keys(next);
  while (orgIds.length > MAX_REMOTE_SESSION_CACHE_ENTRIES) {
    const oldest = orgIds.shift();
    if (oldest) delete next[oldest];
  }
  return next;
}

export type CloudRemoteSessionsFetchState =
  | "idle"
  | "loading"
  | "ready"
  | "error";

export interface CloudOrgRemoteSessionsEntry {
  /** Prevents app-lifetime rows from crossing a sign-out/account switch. */
  identityKey?: string;
  rows: RemoteTeammateSessionMetadata[];
  state: CloudRemoteSessionsFetchState;
  /** Epoch ms of the last completed fetch attempt (0 ⇒ never fetched). */
  fetchedAt: number;
  /** Server-clock delta cursor; absent forces a complete listing. */
  serverCursor?: string;
}

const EMPTY_ENTRY: CloudOrgRemoteSessionsEntry = {
  rows: [],
  state: "idle",
  fetchedAt: 0,
};

/** Merge a server delta and apply soft-tombstones without duplicating rows. */
export function mergeRemoteSessionDelta(
  previous: readonly RemoteTeammateSessionMetadata[],
  delta: readonly RemoteTeammateSessionMetadata[]
): RemoteTeammateSessionMetadata[] {
  const byId = new Map(previous.map((row) => [row.id, row]));
  for (const row of delta) {
    if (row.deletedAt) byId.delete(row.id);
    else byId.set(row.id, row);
  }
  return [...byId.values()].sort((left, right) =>
    (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? "")
  );
}

function jsonValueEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((value, index) => jsonValueEquals(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        jsonValueEquals(leftRecord[key], rightRecord[key])
    )
  );
}

/**
 * Preserve row-array identity when a refresh returns the same server truth.
 * Consumers derive the entire sidebar tree from this array, so structural
 * sharing avoids rebuilding and repainting every Team Sessions row for a
 * no-op reconnect/TTL refresh.
 */
export function retainUnchangedRemoteSessionRows(
  previous: RemoteTeammateSessionMetadata[],
  next: RemoteTeammateSessionMetadata[]
): RemoteTeammateSessionMetadata[] {
  return jsonValueEquals(previous, next) ? previous : next;
}

function cursorFromServerTime(
  serverTime: string | undefined,
  fallback: string | undefined
): string | undefined {
  if (!serverTime) return fallback;
  const serverMs = new Date(serverTime).getTime();
  if (!Number.isFinite(serverMs)) return fallback;
  return new Date(serverMs - REMOTE_SESSIONS_CURSOR_OVERLAP_MS).toISOString();
}

export function beginRemoteSessionsFetch(
  entry: CloudOrgRemoteSessionsEntry | undefined,
  identityKey?: string
): CloudOrgRemoteSessionsEntry {
  const current =
    identityKey && entry?.identityKey !== identityKey
      ? EMPTY_ENTRY
      : (entry ?? EMPTY_ENTRY);
  if (current.fetchedAt !== 0) return current;
  return {
    ...current,
    ...(identityKey ? { identityKey } : {}),
    // "loading" is an INITIAL-load UI state only. Realtime invalidations and
    // foreground recovery are background revalidations: keep the last ready
    // snapshot visible instead of flashing an empty/loading row every time.
    state: current.fetchedAt === 0 ? "loading" : current.state,
  };
}

export function remoteSessionsEntryForIdentity(
  entry: CloudOrgRemoteSessionsEntry | undefined,
  identityKey: string | null
): CloudOrgRemoteSessionsEntry | undefined {
  if (!identityKey || entry?.identityKey !== identityKey) return undefined;
  return entry;
}

export function failRemoteSessionsFetch(
  entry: CloudOrgRemoteSessionsEntry | undefined,
  fetchedAt: number
): CloudOrgRemoteSessionsEntry {
  const current = entry ?? EMPTY_ENTRY;
  return {
    ...current,
    // A failed background revalidation must not discard a valid snapshot or
    // replace it with an error placeholder. Initial load still surfaces the
    // error because there is no previously completed fetch to preserve.
    state: current.state === "ready" ? "ready" : "error",
    fetchedAt,
  };
}

export const org2CloudRemoteSessionsAtom = atom<
  Record<string, CloudOrgRemoteSessionsEntry>
>({});
org2CloudRemoteSessionsAtom.debugLabel = "org2CloudRemoteSessionsAtom";

/**
 * Per-org invalidation signal for the remote-sessions list. Plane-specific
 * Presence nudges provide the live path; the durable signal event and
 * reconnect recovery cover missed broadcasts. Fetches after the first
 * snapshot use the server cursor and merge deltas/tombstones.
 * `fullRefreshVersion` advances when reconnect/foreground recovery needs an
 * authoritative listing without deleting the last visible snapshot first.
 */
export interface CloudRemoteSessionsInvalidation {
  version: number;
  fullRefreshVersion: number;
}

export function bumpRemoteSessionsInvalidation(
  current: Record<string, CloudRemoteSessionsInvalidation>,
  orgId: string,
  options: { full?: boolean } = {}
): Record<string, CloudRemoteSessionsInvalidation> {
  const previous = current[orgId];
  const next = { ...current };
  delete next[orgId];
  next[orgId] = {
    version: (previous?.version ?? 0) + 1,
    fullRefreshVersion:
      (previous?.fullRefreshVersion ?? 0) + (options.full ? 1 : 0),
  };
  const orgIds = Object.keys(next);
  while (orgIds.length > MAX_REMOTE_SESSIONS_VERSION_KEYS) {
    const oldest = orgIds.shift();
    if (oldest) delete next[oldest];
  }
  return next;
}

export const org2CloudRemoteSessionsVersionAtom = atom<
  Record<string, CloudRemoteSessionsInvalidation>
>({});
org2CloudRemoteSessionsVersionAtom.debugLabel =
  "org2CloudRemoteSessionsVersionAtom";

export interface UseCloudOrgRemoteSessionsResult {
  rows: RemoteTeammateSessionMetadata[];
  state: CloudRemoteSessionsFetchState;
  /**
   * Epoch ms of the last COMPLETED fetch (0 ⇒ never). The freshness signal
   * `state` cannot give: a revalidation keeps `state` at "ready" with the
   * previous rows on purpose, so "ready" means "a fetch once finished",
   * not "this snapshot is current".
   */
  fetchedAt: number;
  /** Re-renders on visibility flips so demand-driven consumers can resume. */
  documentVisible: boolean;
  /** Replace the current snapshot now. */
  refresh: () => void;
}

/**
 * Rows for `orgId` (null ⇒ no cloud scope active — returns the idle empty
 * entry and fetches nothing). Auto-fetches the initial snapshot and responds
 * to Realtime invalidations. Foreground recovery and `refresh()` are explicit
 * full-fetch events; there is no recurring or render-driven TTL poll.
 */
export function useCloudOrgRemoteSessions(
  orgId: string | null
): UseCloudOrgRemoteSessionsResult {
  const store = useStore();
  const requestState = requestStateFor(store);
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const [entries, setEntries] = useAtom(org2CloudRemoteSessionsAtom);
  const versionByOrg = useAtomValue(org2CloudRemoteSessionsVersionAtom);
  const setVersionByOrg = useSetAtom(org2CloudRemoteSessionsVersionAtom);
  const invalidationSignal = orgId ? versionByOrg[orgId] : undefined;
  const invalidationVersion = invalidationSignal?.version ?? 0;
  const fullRefreshVersion = invalidationSignal?.fullRefreshVersion ?? 0;
  const [documentVisible, setDocumentVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState !== "hidden"
  );
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onVisibilityChange = () => {
      setDocumentVisible(document.visibilityState !== "hidden");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);
  const entriesRef = useRef(entries);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);
  // Latest auth via ref so the token-refresh write inside the fetch does
  // not retrigger it (same idiom as org2CloudOrgsAtom).
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);
  const signedIn = Boolean(auth);
  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  useEffect(() => {
    if (requestState.activeIdentityKey === authIdentityKey) return;
    requestState.activeIdentityKey = authIdentityKey;
    requestState.lastFetchedVersionByKey.clear();
    requestState.lastFullRefreshVersionByKey.clear();
    // Rows are server-authorized. Drop the previous identity's snapshots
    // immediately instead of retaining invisible data for the app lifetime.
    setEntries({});
    setVersionByOrg({});
  }, [authIdentityKey, requestState, setEntries, setVersionByOrg]);
  const entrySnapshot = orgId
    ? remoteSessionsEntryForIdentity(entries[orgId], authIdentityKey)
    : undefined;
  const fetchOrgSessions = useCallback(
    async (
      targetOrgId: string,
      options: { full?: boolean } = {}
    ): Promise<void> => {
      const current = authRef.current;
      if (!current) return;
      const identityKey = org2CloudAuthIdentityKey(current);
      const requestKey = `${identityKey}|${targetOrgId}`;
      if (requestState.inFlightKeys.has(requestKey)) return;
      requestState.inFlightKeys.add(requestKey);
      const entryAtStart = remoteSessionsEntryForIdentity(
        entriesRef.current[targetOrgId],
        identityKey
      );
      const since = options.full ? undefined : entryAtStart?.serverCursor;
      setEntries((previous) => {
        const currentEntry = previous[targetOrgId];
        const nextEntry = beginRemoteSessionsFetch(currentEntry, identityKey);
        return currentEntry === nextEntry
          ? previous
          : writeRemoteSessionsEntry(previous, targetOrgId, nextEntry);
      });
      try {
        const fresh = await ensureFreshSession(current);
        if (!fresh) throw new Error("token refresh failed");
        commitRefreshedAuth(setAuth, current, fresh);
        const result = await listOrgSessions(
          fresh.accessToken,
          targetOrgId,
          since
        );
        const latest = authRef.current;
        if (!latest || org2CloudAuthIdentityKey(latest) !== identityKey) {
          return;
        }
        setEntries((previous) => {
          const current = remoteSessionsEntryForIdentity(
            previous[targetOrgId],
            identityKey
          );
          // If lifecycle eviction removes this entry while an older delta is
          // in flight, never let that partial response recreate the cache.
          // Writing an idle sentinel wakes the effect after the request leaves
          // the single-flight set, so the next call is an authoritative list.
          if (since && !current) {
            return writeRemoteSessionsEntry(previous, targetOrgId, {
              identityKey,
              rows: [],
              state: "idle",
              fetchedAt: 0,
            });
          }
          const previousRows = current?.rows ?? [];
          const refreshedRows = since
            ? mergeRemoteSessionDelta(previousRows, result.sessions)
            : result.sessions.filter((row) => !row.deletedAt);
          const rows = retainUnchangedRemoteSessionRows(
            previousRows,
            refreshedRows
          );
          return writeRemoteSessionsEntry(previous, targetOrgId, {
            identityKey,
            rows,
            state: "ready",
            fetchedAt: Date.now(),
            serverCursor: cursorFromServerTime(
              result.serverTime,
              current?.serverCursor
            ),
          });
        });
      } catch (error) {
        log.warn("cloud_list_org_sessions failed:", error);
        setEntries((previous) =>
          previous[targetOrgId]?.identityKey === identityKey
            ? writeRemoteSessionsEntry(
                previous,
                targetOrgId,
                failRemoteSessionsFetch(previous[targetOrgId], Date.now())
              )
            : previous
        );
      } finally {
        requestState.inFlightKeys.delete(requestKey);
      }
    },
    [requestState, setAuth, setEntries]
  );

  // Effect re-runs on: scope switch (orgId), sign-in flip, and each Realtime
  // invalidation bump. On a bump the fetch runs immediately — the signal
  // means the server HAS newer rows. The identity-keyed fetched-version
  // map keeps a bump from re-firing after its fetch already ran. `entrySnapshot` is
  // intentionally a dependency: when a newer invalidation arrives during an
  // older in-flight request, that request's completion wakes this effect and
  // lets the queued version fetch instead of stranding it until another
  // foreground/reconnect event.
  useEffect(() => {
    if (!orgId || !signedIn || !authIdentityKey) return;
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    )
      return;
    const entry = remoteSessionsEntryForIdentity(
      entriesRef.current[orgId],
      authIdentityKey
    );
    const requestKey = `${authIdentityKey}|${orgId}`;
    const lastFetchedVersion =
      requestState.lastFetchedVersionByKey.get(requestKey) ?? 0;
    const lastFullRefreshVersion =
      requestState.lastFullRefreshVersionByKey.get(requestKey) ?? 0;
    const invalidated = invalidationVersion > lastFetchedVersion;
    const fullInvalidated = fullRefreshVersion > lastFullRefreshVersion;
    const needsInitialSnapshot = !entry || entry.state === "idle";
    if (
      (!needsInitialSnapshot && !invalidated) ||
      requestState.inFlightKeys.has(requestKey)
    ) {
      return;
    }
    rememberRemoteSessionsFetchedVersion(
      requestState.lastFetchedVersionByKey,
      requestKey,
      invalidationVersion
    );
    rememberRemoteSessionsFetchedVersion(
      requestState.lastFullRefreshVersionByKey,
      requestKey,
      fullRefreshVersion
    );
    void fetchOrgSessions(orgId, { full: fullInvalidated });
  }, [
    orgId,
    signedIn,
    invalidationVersion,
    fullRefreshVersion,
    entrySnapshot,
    authIdentityKey,
    fetchOrgSessions,
    requestState,
  ]);

  // A foreground transition is an explicit recovery boundary: the Realtime
  // lease was released while unfocused/hidden, so replace the listing once
  // after focus returns. This also gives a timed-out initial RPC a deterministic
  // user-driven retry without introducing a timer loop. Flap-cooled: the
  // recovery is a FULL paged listing, so alt-tab bursts pay for one.
  const lastFocusRecoverAtRef = useRef(0);
  useEffect(() => {
    if (
      !orgId ||
      !signedIn ||
      !authIdentityKey ||
      typeof window === "undefined" ||
      typeof document === "undefined"
    ) {
      return undefined;
    }
    const recover = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      if (
        typeof document !== "undefined" &&
        typeof document.hasFocus === "function" &&
        !document.hasFocus()
      ) {
        return;
      }
      if (requestState.inFlightKeys.has(`${authIdentityKey}|${orgId}`)) return;
      if (
        Date.now() - lastFocusRecoverAtRef.current <
        FOCUS_REFRESH_COOLDOWN_MS
      ) {
        return;
      }
      lastFocusRecoverAtRef.current = Date.now();
      void fetchOrgSessions(orgId, { full: true });
    };
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", recover);
    return () => {
      window.removeEventListener("focus", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [authIdentityKey, fetchOrgSessions, orgId, requestState, signedIn]);

  const refresh = useCallback(() => {
    if (!orgId || !signedIn || !authIdentityKey) return;
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    )
      return;
    if (requestState.inFlightKeys.has(`${authIdentityKey}|${orgId}`)) return;
    void fetchOrgSessions(orgId, { full: true });
  }, [orgId, signedIn, authIdentityKey, fetchOrgSessions, requestState]);

  const entry = entrySnapshot ?? EMPTY_ENTRY;
  return {
    rows: entry.rows,
    state: entry.state,
    fetchedAt: entry.fetchedAt,
    documentVisible,
    refresh,
  };
}
