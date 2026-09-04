import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SHARED_AUTH_SYNCHRONIZED_EVENT } from "@src/api/http/auth/sharedAuthStorage";
import { createZodJsonStorage } from "@src/util/core/storage/zodStorage";

import {
  ORG2_CLOUD_AUTH_STORAGE_KEY,
  type Org2CloudAuthState,
  Org2CloudAuthStateSchema,
  clearRejectedAuth,
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

  it("applies a shared-store synchronization while the atom is mounted", () => {
    const eventTarget = new EventTarget();
    const addEventListener = vi
      .spyOn(window, "addEventListener")
      .mockImplementation(eventTarget.addEventListener.bind(eventTarget));
    const removeEventListener = vi
      .spyOn(window, "removeEventListener")
      .mockImplementation(eventTarget.removeEventListener.bind(eventTarget));
    const store = createStore();
    const unsubscribe = store.sub(org2CloudAuthAtom, () => {});
    localStorage.setItem(
      ORG2_CLOUD_AUTH_STORAGE_KEY,
      JSON.stringify(VALID_STATE)
    );

    eventTarget.dispatchEvent(new Event(SHARED_AUTH_SYNCHRONIZED_EVENT));

    expect(store.get(org2CloudAuthAtom)).toEqual(VALID_STATE);
    unsubscribe();
    addEventListener.mockRestore();
    removeEventListener.mockRestore();
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

describe("clearRejectedAuth", () => {
  it("clears the atom when the atom holds a DIFFERENT OBJECT with the same identity", () => {
    // Regression for the zombie-signed-in bug: `atomWithStorage`'s onMount
    // re-hydrates a freshly parsed object from localStorage on every mount
    // (see the module doc comment), so the atom's live value is routinely
    // NOT `===` a `current` snapshot captured just beforehand even though
    // it is the exact same session. Rebuild that with a spread copy rather
    // than reusing the VALID_STATE reference.
    const store = createStore();
    const rehydrated: Org2CloudAuthState = { ...VALID_STATE };
    expect(rehydrated).not.toBe(VALID_STATE);
    store.set(org2CloudAuthAtom, rehydrated);

    expect(clearRejectedAuth(boundSetter(store), VALID_STATE)).toBe(true);

    expect(store.get(org2CloudAuthAtom)).toBeNull();
  });

  it("is a no-op when already signed out", () => {
    const store = createStore();
    store.set(org2CloudAuthAtom, null);

    expect(clearRejectedAuth(boundSetter(store), VALID_STATE)).toBe(false);

    expect(store.get(org2CloudAuthAtom)).toBeNull();
  });

  it("does NOT clear a newer sign-in by a different user (CAS)", () => {
    const store = createStore();
    const newerLogin: Org2CloudAuthState = {
      ...VALID_STATE,
      userId: "user-2",
      refreshToken: "rt-other",
    };
    store.set(org2CloudAuthAtom, newerLogin);

    expect(clearRejectedAuth(boundSetter(store), VALID_STATE)).toBe(false);

    expect(store.get(org2CloudAuthAtom)).toBe(newerLogin);
  });

  it("does NOT clear a session already rotated by a concurrent successful refresh (CAS)", () => {
    const store = createStore();
    const rotated: Org2CloudAuthState = {
      ...VALID_STATE,
      accessToken: "at-2",
      refreshToken: "rt-2",
    };
    store.set(org2CloudAuthAtom, rotated);

    // The rejection carries the STALE (pre-rotation) refresh token.
    expect(clearRejectedAuth(boundSetter(store), VALID_STATE)).toBe(false);

    expect(store.get(org2CloudAuthAtom)).toBe(rotated);
  });
});

// The four @agent-adjacent callers (MoveToOrgDialog, useWorkstationSidebarHandlers,
// useForkImportedSession, CollabOrgForm) all rotate the single-use refresh
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

// `useOrg2CloudOrgs` (org2CloudOrgsAtom.ts) wires `ensureFreshSession`'s
// `onRefreshRejected` straight to `clearRejectedAuth`. This exercises that
// exact composition against a live (mocked) GoTrue response, matching the
// bug report: a 400 `invalid_grant` from the refresh endpoint.
describe("signing out locally on a rejected refresh (ensureFreshSession + clearRejectedAuth)", () => {
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

  /** The `useOrg2CloudOrgs` onRefreshRejected composition under test. */
  async function attemptRefresh(
    store: ReturnType<typeof createStore>,
    current: Org2CloudAuthState
  ): Promise<{ fresh: Org2CloudAuthState | null; cleared: boolean }> {
    let cleared = false;
    const fresh = await ensureFreshSession(current, {
      onRefreshRejected: () => {
        cleared = clearRejectedAuth(boundSetter(store), current);
      },
    });
    return { fresh, cleared };
  }

  it("(a) a 400 invalid_grant rejection clears the atom, flipping the UI signed-out", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "invalid_grant" }, 400)
    );
    const store = createStore();
    // A freshly re-hydrated object (see clearRejectedAuth's doc comment) —
    // NOT the same reference the earlier reference-equality guard needed.
    const rehydrated: Org2CloudAuthState = { ...VALID_STATE };
    store.set(org2CloudAuthAtom, rehydrated);

    const { fresh, cleared } = await attemptRefresh(store, VALID_STATE);

    expect(fresh).toBeNull();
    expect(cleared).toBe(true);
    // TeamRuntimePanel/sidebar phase derivation keys off `!auth` — this is
    // the same condition that flips the UI to its signed-out affordances.
    expect(store.get(org2CloudAuthAtom)).toBeNull();
  });

  it("(b) a network error retains auth (transient failures stay on the retry path)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const store = createStore();
    const rehydrated: Org2CloudAuthState = { ...VALID_STATE };
    store.set(org2CloudAuthAtom, rehydrated);

    const { fresh, cleared } = await attemptRefresh(store, VALID_STATE);

    expect(fresh).toBeNull();
    expect(cleared).toBe(false);
    expect(store.get(org2CloudAuthAtom)).toBe(rehydrated);
  });

  it("(c) a rejection arriving after a newer login leaves the newer session untouched", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "invalid_grant" }, 400)
    );
    const store = createStore();
    store.set(org2CloudAuthAtom, VALID_STATE);

    const refreshPromise = attemptRefresh(store, VALID_STATE);
    // A newer sign-in (different user + tokens) lands while the stale
    // refresh for VALID_STATE is still in flight.
    const newerLogin: Org2CloudAuthState = {
      ...VALID_STATE,
      userId: "user-2",
      accessToken: "at-newer",
      refreshToken: "rt-newer",
    };
    store.set(org2CloudAuthAtom, newerLogin);

    const { cleared } = await refreshPromise;

    expect(cleared).toBe(false);
    expect(store.get(org2CloudAuthAtom)).toBe(newerLogin);
  });
});
