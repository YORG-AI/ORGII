/**
 * Per-cloud-org remote session rows for the sidebar (in-memory only).
 *
 * Maps orgId → the org's retention-windowed `cloud_list_org_sessions` rows
 * plus fetch state. Fetched lazily by `useCloudOrgRemoteSessions` when the
 * sidebar's active scope is that cloud org, with a short TTL so re-selecting
 * an org doesn't refetch on every render; `refresh()` bypasses the TTL.
 * NOT persisted — retention filtering is server-side and rows go stale.
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
import { listOrgSessions } from "./org2CloudSyncClient";

const log = createLogger("Org2CloudRemoteSessions");

const REMOTE_SESSIONS_TTL_MS = 60_000;
const REMOTE_SESSIONS_CURSOR_OVERLAP_MS = 2_000;
export const MAX_REMOTE_SESSION_CACHE_ENTRIES = 64;
export const MAX_REMOTE_SESSIONS_VERSION_KEYS = 64;

type JotaiStore = ReturnType<typeof createStore>;
interface RemoteSessionsRequestState {
  inFlightKeys: Set<string>;
  lastFetchedVersionByKey: Map<string, number>;
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
  return {
    ...current,
    ...(identityKey ? { identityKey } : {}),
    // "loading" is an INITIAL-load UI state only. Realtime invalidations and
    // the 60s safety TTL are background revalidations: keep the last ready
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
 * Per-org invalidation counter for the remote-sessions list. Plane-specific
 * Presence nudges provide the live path; the bounded durable signal fallback
 * and reconnect recovery cover missed broadcasts. Fetches after the first
 * snapshot use the server cursor and merge deltas/tombstones.
 */
export const org2CloudRemoteSessionsVersionAtom = atom<Record<string, number>>(
  {}
);
org2CloudRemoteSessionsVersionAtom.debugLabel =
  "org2CloudRemoteSessionsVersionAtom";

export interface UseCloudOrgRemoteSessionsResult {
  rows: RemoteTeammateSessionMetadata[];
  state: CloudRemoteSessionsFetchState;
  /** Refetch now, ignoring the TTL. */
  refresh: () => void;
}

/**
 * Rows for `orgId` (null ⇒ no cloud scope active — returns the idle empty
 * entry and fetches nothing). Auto-fetches when the entry is missing or
 * older than the TTL.
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
  const invalidationVersion = orgId ? (versionByOrg[orgId] ?? 0) : 0;
  const [visibilityVersion, setVisibilityVersion] = useState(0);
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") {
        setVisibilityVersion((version) => version + 1);
      }
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
      setEntries((previous) =>
        writeRemoteSessionsEntry(
          previous,
          targetOrgId,
          beginRemoteSessionsFetch(previous[targetOrgId], identityKey)
        )
      );
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
          // A reconnect/full-refresh invalidation removes the cached entry. If
          // an older delta request was already in flight, never let its partial
          // response recreate that entry and turn the required full reload back
          // into another delta. Writing an idle sentinel wakes the effect after
          // the request leaves the single-flight set, so the next call is full.
          if (since && !current) {
            return writeRemoteSessionsEntry(previous, targetOrgId, {
              identityKey,
              rows: [],
              state: "idle",
              fetchedAt: 0,
            });
          }
          const rows = since
            ? mergeRemoteSessionDelta(current?.rows ?? [], result.sessions)
            : result.sessions.filter((row) => !row.deletedAt);
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
  // invalidation bump. On a bump the fetch runs regardless of TTL — the
  // signal means the server HAS newer rows. The identity-keyed fetched-version
  // map keeps a bump from re-firing after its fetch already ran. `entrySnapshot` is
  // intentionally a dependency: when a newer invalidation arrives during an
  // older in-flight request, that request's completion wakes this effect and
  // lets the queued version fetch instead of stranding it until the 60s TTL.
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
    const invalidated = invalidationVersion > lastFetchedVersion;
    const stale =
      !entry ||
      entry.state === "idle" ||
      Date.now() - entry.fetchedAt > REMOTE_SESSIONS_TTL_MS;
    if ((!stale && !invalidated) || requestState.inFlightKeys.has(requestKey)) {
      return;
    }
    rememberRemoteSessionsFetchedVersion(
      requestState.lastFetchedVersionByKey,
      requestKey,
      invalidationVersion
    );
    void fetchOrgSessions(orgId);
  }, [
    orgId,
    signedIn,
    invalidationVersion,
    entrySnapshot,
    authIdentityKey,
    fetchOrgSessions,
    requestState,
    visibilityVersion,
  ]);

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
  return { rows: entry.rows, state: entry.state, refresh };
}
