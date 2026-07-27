import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { refreshOrg2CloudAuthForAction } from "./org2CloudAuthAction";
import {
  type Org2CloudAuthState,
  org2CloudAuthAtom,
} from "./org2CloudAuthAtom";

const fetchMock = vi.fn();

const CURRENT: Org2CloudAuthState = {
  kind: "org2_cloud",
  supabaseUrl: "https://cloud.example.test",
  supabaseAnonKey: "anon-key",
  userId: "user-1",
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: 0,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function boundSetter(store: ReturnType<typeof createStore>) {
  return (
    update: (previous: Org2CloudAuthState | null) => Org2CloudAuthState | null
  ): void => {
    store.set(org2CloudAuthAtom, update);
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("refreshOrg2CloudAuthForAction", () => {
  it("rotates and persists a refresh-token family before the action continues", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      })
    );
    const store = createStore();
    store.set(org2CloudAuthAtom, CURRENT);

    const result = await refreshOrg2CloudAuthForAction(
      CURRENT,
      boundSetter(store)
    );

    expect(result.status).toBe("ready");
    expect(store.get(org2CloudAuthAtom)?.refreshToken).toBe("refresh-2");
  });

  it("clears the rejected persisted session and reports it as expired", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
    const store = createStore();
    store.set(org2CloudAuthAtom, CURRENT);

    await expect(
      refreshOrg2CloudAuthForAction(CURRENT, boundSetter(store))
    ).resolves.toEqual({ status: "expired" });
    expect(store.get(org2CloudAuthAtom)).toBeNull();
  });

  it("keeps the session on a retryable network failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const store = createStore();
    store.set(org2CloudAuthAtom, CURRENT);

    await expect(
      refreshOrg2CloudAuthForAction(CURRENT, boundSetter(store))
    ).resolves.toEqual({ status: "unavailable" });
    expect(store.get(org2CloudAuthAtom)).toBe(CURRENT);
  });

  it("does not clear a newer login when an older refresh is rejected late", async () => {
    let resolveRefresh: ((response: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        })
    );
    const store = createStore();
    store.set(org2CloudAuthAtom, CURRENT);
    const request = refreshOrg2CloudAuthForAction(CURRENT, boundSetter(store));
    const newer: Org2CloudAuthState = {
      ...CURRENT,
      userId: "user-2",
      refreshToken: "refresh-newer",
    };
    store.set(org2CloudAuthAtom, newer);

    resolveRefresh?.(jsonResponse({}, 401));

    await expect(request).resolves.toEqual({ status: "superseded" });
    expect(store.get(org2CloudAuthAtom)).toBe(newer);
  });
});
