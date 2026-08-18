import { createStore, getDefaultStore } from "jotai";
import { describe, expect, it } from "vitest";

import {
  readIdentitySnapshot,
  replaceIdentitySnapshot,
} from "@src/features/Identity/identitySnapshotAtom";
import type { IdentitySnapshot } from "@src/features/Identity/identityTypes";

import {
  type Org2CloudAuthState,
  Org2CloudAuthStateSchema,
  type Org2CloudRequestAuth,
  clearRejectedAuth,
  commitRefreshedAuth,
  org2CloudAuthAtom,
  parseStoredOrg2CloudAuth,
} from "./org2CloudAuthAtom";

const AUTH: Org2CloudAuthState = {
  kind: "org2_cloud",
  sessionId: "00000000-0000-4000-8000-000000000001",
  generation: 3,
  supabaseUrl: "https://cloud.example.test",
  userId: "user-1",
  profile: { displayName: "Ada" },
};

const LEASE: Org2CloudRequestAuth = {
  ...AUTH,
  supabaseAnonKey: "public-key",
  accessToken: "short-access",
  expiresAt: 2_000_000_000,
};

function snapshot(
  revision: number,
  status: "ready" | "reauth_required" = "ready"
): IdentitySnapshot {
  return {
    revision,
    sessions: [
      {
        sessionId: AUTH.sessionId,
        realm: "org2_cloud",
        issuer: AUTH.supabaseUrl,
        subject: AUTH.userId,
        displayName: "Ada",
        scopes: ["profile", "email"],
        status,
        generation: AUTH.generation,
      },
    ],
    activeSessions: { org2_cloud: AUTH.sessionId },
    flows: [],
    secureStoreStatus: "available",
  };
}

describe("non-secret Cloud auth projection", () => {
  it("rejects access and refresh credentials from the persisted projection schema", () => {
    expect(
      Org2CloudAuthStateSchema.safeParse({ ...AUTH, accessToken: "forbidden" })
        .success
    ).toBe(false);
    expect(
      Org2CloudAuthStateSchema.safeParse({ ...AUTH, refreshToken: "forbidden" })
        .success
    ).toBe(false);
  });

  it("parses the old envelope only through the migration schema", () => {
    expect(
      parseStoredOrg2CloudAuth(
        JSON.stringify({
          kind: "org2_cloud",
          supabaseUrl: AUTH.supabaseUrl,
          supabaseAnonKey: "public-key",
          userId: AUTH.userId,
          accessToken: "old-access",
          refreshToken: "old-refresh",
          expiresAt: 2_000_000_000,
        })
      )?.refreshToken
    ).toBe("old-refresh");
  });

  it("uses commit as a generation guard without writing the lease", () => {
    const store = createStore();
    store.set(org2CloudAuthAtom, AUTH);
    expect(
      commitRefreshedAuth(
        (update) => store.set(org2CloudAuthAtom, update),
        AUTH,
        LEASE
      )
    ).toBe(true);
    expect(store.get(org2CloudAuthAtom)).toEqual(AUTH);
    expect("accessToken" in (store.get(org2CloudAuthAtom) ?? {})).toBe(false);

    const replacement = { ...AUTH, generation: AUTH.generation + 1 };
    store.set(org2CloudAuthAtom, replacement);
    expect(
      commitRefreshedAuth(
        (update) => store.set(org2CloudAuthAtom, update),
        AUTH,
        LEASE
      )
    ).toBe(false);
    expect(store.get(org2CloudAuthAtom)).toEqual(replacement);
  });

  it("clears only the rejected session generation", () => {
    const store = createStore();
    store.set(org2CloudAuthAtom, AUTH);
    expect(
      clearRejectedAuth((update) => store.set(org2CloudAuthAtom, update), AUTH)
    ).toBe(true);
    expect(store.get(org2CloudAuthAtom)).toBeNull();
  });

  it("tracks accepted Broker snapshots and hides reauth-required sessions", () => {
    const revision = readIdentitySnapshot().revision + 1;
    replaceIdentitySnapshot(snapshot(revision));
    expect(getDefaultStore().get(org2CloudAuthAtom)).toMatchObject(AUTH);

    replaceIdentitySnapshot(snapshot(revision + 1, "reauth_required"));
    expect(getDefaultStore().get(org2CloudAuthAtom)).toBeNull();
  });
});
