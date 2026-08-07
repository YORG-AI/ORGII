/**
 * Per-cloud-org remote session rows for the sidebar (in-memory only).
 *
 * Maps orgId → the org's retention-windowed `cloud_list_org_sessions` rows
 * plus fetch state. Fetched lazily by `useCloudOrgRemoteSessions` when the
 * sidebar's active scope is that cloud org, with a short TTL so re-selecting
 * an org doesn't refetch on every render; `refresh()` bypasses the TTL.
 * NOT persisted — retention filtering is server-side and rows go stale.
 */
import { atom, useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import { createLogger } from "@src/hooks/logger";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import { commitRefreshedAuth, org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { ensureFreshSession } from "./org2CloudClient";
import { listOrgSessions } from "./org2CloudSyncClient";

const log = createLogger("Org2CloudRemoteSessions");

const REMOTE_SESSIONS_TTL_MS = 60_000;

export type CloudRemoteSessionsFetchState =
  | "idle"
  | "loading"
  | "ready"
  | "error";

export interface CloudOrgRemoteSessionsEntry {
  rows: RemoteTeammateSessionMetadata[];
  state: CloudRemoteSessionsFetchState;
  /** Epoch ms of the last completed fetch attempt (0 ⇒ never fetched). */
  fetchedAt: number;
}

const EMPTY_ENTRY: CloudOrgRemoteSessionsEntry = {
  rows: [],
  state: "idle",
  fetchedAt: 0,
};

export function beginRemoteSessionsFetch(
  entry: CloudOrgRemoteSessionsEntry | undefined
): CloudOrgRemoteSessionsEntry {
  const current = entry ?? EMPTY_ENTRY;
  return {
    ...current,
    // "loading" is an INITIAL-load UI state only. Realtime invalidations and
    // the 60s safety TTL are background revalidations: keep the last ready
    // snapshot visible instead of flashing an empty/loading row every time.
    state: current.fetchedAt === 0 ? "loading" : current.state,
  };
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
 * Per-org invalidation counter for the remote-sessions list, bumped by the
 * Realtime `org_change_signals` subscription (useOrg2CloudRealtime) whenever
 * a teammate's session push / access change / delete lands. The fetch effect
 * keys on it, so the TEAM SESSIONS section refreshes live instead of only on
 * scope switches past the 60s TTL.
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
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const [entries, setEntries] = useAtom(org2CloudRemoteSessionsAtom);
  const versionByOrg = useAtomValue(org2CloudRemoteSessionsVersionAtom);
  const invalidationVersion = orgId ? (versionByOrg[orgId] ?? 0) : 0;
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
  // Background revalidation deliberately keeps state="ready", so UI state can
  // no longer double as an in-flight lock. Track requests separately to
  // collapse Realtime signal bursts and the fallback TTL into one fetch/org.
  const inFlightOrgIdsRef = useRef(new Set<string>());

  const fetchOrgSessions = useCallback(
    async (targetOrgId: string): Promise<void> => {
      if (inFlightOrgIdsRef.current.has(targetOrgId)) return;
      const current = authRef.current;
      if (!current) return;
      inFlightOrgIdsRef.current.add(targetOrgId);
      setEntries((previous) => ({
        ...previous,
        [targetOrgId]: beginRemoteSessionsFetch(previous[targetOrgId]),
      }));
      try {
        const fresh = await ensureFreshSession(current);
        if (!fresh) throw new Error("token refresh failed");
        commitRefreshedAuth(setAuth, current, fresh);
        const result = await listOrgSessions(fresh.accessToken, targetOrgId);
        setEntries((previous) => ({
          ...previous,
          [targetOrgId]: {
            rows: result.sessions,
            state: "ready",
            fetchedAt: Date.now(),
          },
        }));
      } catch (error) {
        log.warn("cloud_list_org_sessions failed:", error);
        setEntries((previous) => ({
          ...previous,
          [targetOrgId]: failRemoteSessionsFetch(
            previous[targetOrgId],
            Date.now()
          ),
        }));
      } finally {
        inFlightOrgIdsRef.current.delete(targetOrgId);
      }
    },
    [setAuth, setEntries]
  );

  // Effect re-runs on: scope switch (orgId), sign-in flip, and each Realtime
  // invalidation bump. On a bump the fetch runs regardless of TTL — the
  // signal means the server HAS newer rows. `lastFetchedVersionRef` keeps a
  // bump from re-firing after its fetch already ran (entries updates would
  // otherwise re-trigger via fetchedAt churn).
  const lastFetchedVersionRef = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!orgId || !signedIn) return;
    const entry = entriesRef.current[orgId];
    const lastFetchedVersion = lastFetchedVersionRef.current[orgId] ?? 0;
    const invalidated = invalidationVersion > lastFetchedVersion;
    const stale =
      !entry ||
      entry.state === "idle" ||
      Date.now() - entry.fetchedAt > REMOTE_SESSIONS_TTL_MS;
    if ((!stale && !invalidated) || inFlightOrgIdsRef.current.has(orgId)) {
      return;
    }
    lastFetchedVersionRef.current[orgId] = invalidationVersion;
    void fetchOrgSessions(orgId);
  }, [orgId, signedIn, invalidationVersion, fetchOrgSessions]);

  const refresh = useCallback(() => {
    if (!orgId || !signedIn) return;
    if (inFlightOrgIdsRef.current.has(orgId)) return;
    void fetchOrgSessions(orgId);
  }, [orgId, signedIn, fetchOrgSessions]);

  const entry = (orgId ? entries[orgId] : undefined) ?? EMPTY_ENTRY;
  return { rows: entry.rows, state: entry.state, refresh };
}
