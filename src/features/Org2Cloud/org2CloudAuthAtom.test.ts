import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createZodJsonStorage } from "@src/util/core/storage/zodStorage";

import {
  ORG2_CLOUD_AUTH_STORAGE_KEY,
  type Org2CloudAuthState,
  Org2CloudAuthStateSchema,
  commitRefreshedAuth,
  org2CloudAuthAtom,
} from "./org2CloudAuthAtom";
import { ensureFreshSession } from "./org2CloudClient";

const storage = createZodJsonStorage<Org2CloudAuthState | null>(
  Org2CloudAuthStateSchema.nullable()
);

const VALID_STATE: Org2CloudAuthState = {
  kind: "org2_cloud",
  supabaseUrl: "https://example.supabase.co",
  supabaseAnonKey: "sb_publishable_x",
  userId: "user-1",
  accessToken: "at",
  refreshToken: "rt",
  expiresAt: 1751500000,
};

describe("org2CloudAuthAtom storage schema", () => {
  beforeEach(() => {
    localStorage.removeItem(ORG2_CLOUD_AUTH_STORAGE_KEY);
  });

  it("round-trips a valid auth state", () => {
    storage.setItem(ORG2_CLOUD_AUTH_STORAGE_KEY, VALID_STATE);
    expect(storage.getItem(ORG2_CLOUD_AUTH_STORAGE_KEY, null)).toEqual(
      VALID_STATE
    );
  });

  it("round-trips the signed-out null state", () => {
    storage.setItem(ORG2_CLOUD_AUTH_STORAGE_KEY, null);
    expect(storage.getItem(ORG2_CLOUD_AUTH_STORAGE_KEY, VALID_STATE)).toBe(
      null
    );
  });

  it("falls back to the initial value on unparseable JSON", () => {
    localStorage.setItem(ORG2_CLOUD_AUTH_STORAGE_KEY, "{not json");
    expect(storage.getItem(ORG2_CLOUD_AUTH_STORAGE_KEY, null)).toBeNull();
  });

  it("falls back to the initial value on schema-incompatible payloads", () => {
    localStorage.setItem(
      ORG2_CLOUD_AUTH_STORAGE_KEY,
      JSON.stringify({ ...VALID_STATE, expiresAt: "not-a-number" })
    );
    expect(storage.getItem(ORG2_CLOUD_AUTH_STORAGE_KEY, null)).toBeNull();

    localStorage.setItem(
      ORG2_CLOUD_AUTH_STORAGE_KEY,
      JSON.stringify({ ...VALID_STATE, kind: "something_else" })
    );
    expect(storage.getItem(ORG2_CLOUD_AUTH_STORAGE_KEY, null)).toBeNull();
  });

  it("accepts a state with an optional profile", () => {
    const withProfile: Org2CloudAuthState = {
      ...VALID_STATE,
      profile: { displayName: "Vince", primaryEmail: "v@example.com" },
    };
    storage.setItem(ORG2_CLOUD_AUTH_STORAGE_KEY, withProfile);
    expect(storage.getItem(ORG2_CLOUD_AUTH_STORAGE_KEY, null)).toEqual(
      withProfile
    );
  });
});

/** Bind commitRefreshedAuth's setter to a jotai store as the React setter does. */
function boundSetter(store: ReturnType<typeof createStore>) {
  return (
    updater: (prev: Org2CloudAuthState | null) => Org2CloudAuthState | null
  ): void => {
    store.set(org2CloudAuthAtom, updater);
  };
}

describe("commitRefreshedAuth", () => {
  it("commits the rotated session into the atom", () => {
    const store = createStore();
    store.set(org2CloudAuthAtom, VALID_STATE);
    const rotated: Org2CloudAuthState = {
      ...VALID_STATE,
      accessToken: "at-2",
      refreshToken: "rt-2",
      expiresAt: 1751503600,
    };

    expect(commitRefreshedAuth(boundSetter(store), VALID_STATE, rotated)).toBe(
      true
    );

    expect(store.get(org2CloudAuthAtom)).toBe(rotated);
  });

  it("no-ops when ensureFreshSession returned the same object (token still valid)", () => {
    const store = createStore();
    store.set(org2CloudAuthAtom, VALID_STATE);
    let setterCalls = 0;

    commitRefreshedAuth(
      (updater) => {
        setterCalls += 1;
        store.set(org2CloudAuthAtom, updater);
      },
      VALID_STATE,
      VALID_STATE
    );

    expect(setterCalls).toBe(0);
    expect(store.get(org2CloudAuthAtom)).toBe(VALID_STATE);
  });

  it("does NOT resurrect a session the user signed out of mid-flight (CAS)", () => {
    const store = createStore();
    store.set(org2CloudAuthAtom, VALID_STATE);
    const rotated: Org2CloudAuthState = {
      ...VALID_STATE,
      refreshToken: "rt-2",
    };

    store.set(org2CloudAuthAtom, null);
    expect(commitRefreshedAuth(boundSetter(store), VALID_STATE, rotated)).toBe(
      false
    );

    expect(store.get(org2CloudAuthAtom)).toBeNull();
  });

  it("does NOT clobber a different session switched to mid-flight (CAS)", () => {
    const store = createStore();
    store.set(org2CloudAuthAtom, VALID_STATE);
    const rotated: Org2CloudAuthState = {
      ...VALID_STATE,
      refreshToken: "rt-2",
    };
    const switched: Org2CloudAuthState = {
      ...VALID_STATE,
      userId: "user-2",
      refreshToken: "rt-other",
    };

    store.set(org2CloudAuthAtom, switched);
    expect(commitRefreshedAuth(boundSetter(store), VALID_STATE, rotated)).toBe(
      false
    );

    expect(store.get(org2CloudAuthAtom)).toBe(switched);
  });
});

// The four @agent-adjacent callers (MoveToOrgDialog, useWorkstationSidebarHandlers,
// useForkImportedSession, CreateCollabOrgView) all rotate the single-use refresh
// token via ensureFreshSession, then MUST write it back through commitRefreshedAuth.
// This exercises that exact composition end-to-end so a caller that drops or
// blind-sets the rotated token is caught.
describe("caller commit discipline (ensureFreshSession + commitRefreshedAuth)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function rotatedTokenResponse(): Response {
    return jsonResponse({
      access_token: "at-2",
      refresh_token: "rt-2",
      expires_at: 1751503600,
    });
  }

  /** The commit step every fixed caller now runs. */
  async function refreshAndCommit(
    store: ReturnType<typeof createStore>,
    current: Org2CloudAuthState
  ): Promise<Org2CloudAuthState> {
    const fresh = await ensureFreshSession(current);
    if (!fresh) throw new Error("refresh failed");
    commitRefreshedAuth(boundSetter(store), current, fresh);
    return fresh;
  }

  it("persists the rotated refresh token when the JWT is near expiry", async () => {
    fetchMock.mockResolvedValueOnce(rotatedTokenResponse());
    const store = createStore();
    const current: Org2CloudAuthState = {
      ...VALID_STATE,
      expiresAt: Math.floor(Date.now() / 1000),
    };
    store.set(org2CloudAuthAtom, current);

    const fresh = await refreshAndCommit(store, current);

    expect(fresh.refreshToken).toBe("rt-2");
    expect(store.get(org2CloudAuthAtom)?.refreshToken).toBe("rt-2");
    expect(store.get(org2CloudAuthAtom)?.accessToken).toBe("at-2");
  });

  it("leaves the atom untouched (no wasted CAS write) when the JWT is still valid", async () => {
    const store = createStore();
    const current: Org2CloudAuthState = {
      ...VALID_STATE,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    store.set(org2CloudAuthAtom, current);

    await refreshAndCommit(store, current);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.get(org2CloudAuthAtom)).toBe(current);
  });

  it("dropping the commit (the fixed bug) strands the atom on the spent token", async () => {
    fetchMock.mockResolvedValueOnce(rotatedTokenResponse());
    const store = createStore();
    const current: Org2CloudAuthState = {
      ...VALID_STATE,
      expiresAt: Math.floor(Date.now() / 1000),
    };
    store.set(org2CloudAuthAtom, current);

    const fresh = await ensureFreshSession(current);
    expect(fresh?.refreshToken).toBe("rt-2");

    expect(store.get(org2CloudAuthAtom)?.refreshToken).toBe("rt");
  });
});
