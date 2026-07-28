import { atom } from "jotai";

import { createLogger } from "@src/hooks/logger";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "./org2CloudAuthAtom";
import { loadCloudOrgMembers } from "./org2CloudMembersCoordinator";
import { org2CloudRosterVersionAtom } from "./org2CloudOrgsAtom";

const logger = createLogger("org2CloudMemberNames");
export const MAX_CLOUD_MEMBER_NAME_ORGS = 64;

interface CloudMemberNamesEntry {
  identityKey: string;
  rosterVersion: number;
  names: Record<string, string>;
}

export const org2CloudMemberNamesAtom = atom<
  Record<string, CloudMemberNamesEntry>
>({});
org2CloudMemberNamesAtom.debugLabel = "org2CloudMemberNamesAtom";

interface MemberNamesRequest {
  rosterVersion: number;
  promise: Promise<void>;
}

const inFlightByStore = new WeakMap<object, Map<string, MemberNamesRequest>>();

function inFlightFor(store: object): Map<string, MemberNamesRequest> {
  let requests = inFlightByStore.get(store);
  if (!requests) {
    requests = new Map();
    inFlightByStore.set(store, requests);
  }
  return requests;
}

export function resolveCloudMemberName(
  names: Record<string, CloudMemberNamesEntry>,
  cloudOrgId: string,
  userId: string,
  identityKey?: string
): string | null {
  const entry = names[cloudOrgId];
  if (!entry || (identityKey && entry.identityKey !== identityKey)) return null;
  return entry.names[userId] ?? null;
}

export async function ensureCloudMemberNames(
  cloudOrgId: string
): Promise<void> {
  const store = getInstrumentedStore();
  const auth = store.get(org2CloudAuthAtom);
  if (!auth) return;
  const identityKey = org2CloudAuthIdentityKey(auth);
  const rosterVersion = store.get(org2CloudRosterVersionAtom)[cloudOrgId] ?? 0;
  const cached = store.get(org2CloudMemberNamesAtom)[cloudOrgId];
  if (
    cached?.identityKey === identityKey &&
    cached.rosterVersion >= rosterVersion
  ) {
    return;
  }
  const requestKey = `${identityKey}|${cloudOrgId}`;
  const requests = inFlightFor(store);
  const pending = requests.get(requestKey);
  if (pending && pending.rosterVersion >= rosterVersion) {
    await pending.promise;
    return;
  }
  const request: MemberNamesRequest = {
    rosterVersion,
    promise: Promise.resolve(),
  };
  request.promise = (async () => {
    try {
      const loaded = await loadCloudOrgMembers(
        store,
        auth,
        cloudOrgId,
        rosterVersion
      );
      if (!loaded) return;
      commitRefreshedAuth(
        (updater) => store.set(org2CloudAuthAtom, updater),
        auth,
        loaded.auth
      );
      const byUserId: Record<string, string> = {};
      for (const member of loaded.members) {
        if (member.displayName) byUserId[member.userId] = member.displayName;
      }
      const latestAuth = store.get(org2CloudAuthAtom);
      const latestRosterVersion =
        store.get(org2CloudRosterVersionAtom)[cloudOrgId] ?? 0;
      if (
        !latestAuth ||
        org2CloudAuthIdentityKey(latestAuth) !== identityKey ||
        latestRosterVersion > rosterVersion
      ) {
        return;
      }
      store.set(org2CloudMemberNamesAtom, (current) => {
        const next = { ...current };
        // Refresh insertion order so the bounded object behaves as an LRU.
        delete next[cloudOrgId];
        next[cloudOrgId] = {
          identityKey,
          rosterVersion,
          names: byUserId,
        };
        const orgIds = Object.keys(next);
        while (orgIds.length > MAX_CLOUD_MEMBER_NAME_ORGS) {
          const oldestOrgId = orgIds.shift();
          if (oldestOrgId) delete next[oldestOrgId];
        }
        return next;
      });
    } catch (error) {
      logger.warn(`failed to load member roster for ${cloudOrgId}`, error);
    }
  })().finally(() => {
    if (requests.get(requestKey) === request) requests.delete(requestKey);
  });
  requests.set(requestKey, request);
  await request.promise;
}
