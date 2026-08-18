import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { refreshOrg2CloudAuthForAction } from "./org2CloudAuthAction";
import {
  type Org2CloudAuthState,
  type Org2CloudRequestAuth,
  org2CloudAuthAtom,
} from "./org2CloudAuthAtom";

const mocks = vi.hoisted(() => ({ ensureFreshSession: vi.fn() }));

vi.mock("./org2CloudClient", () => ({
  ensureFreshSession: mocks.ensureFreshSession,
}));

const CURRENT: Org2CloudAuthState = {
  kind: "org2_cloud",
  sessionId: "00000000-0000-4000-8000-000000000001",
  generation: 1,
  supabaseUrl: "https://cloud.example.test",
  userId: "user-1",
};

const LEASE: Org2CloudRequestAuth = {
  ...CURRENT,
  supabaseAnonKey: "anon-key",
  accessToken: "access-2",
  expiresAt: 2_000_000_000,
};

function boundSetter(store: ReturnType<typeof createStore>) {
  return (
    update: (previous: Org2CloudAuthState | null) => Org2CloudAuthState | null
  ): void => {
    store.set(org2CloudAuthAtom, update);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("refreshOrg2CloudAuthForAction", () => {
  it("returns a lease without persisting access credentials", async () => {
    mocks.ensureFreshSession.mockResolvedValueOnce(LEASE);
    const store = createStore();
    store.set(org2CloudAuthAtom, CURRENT);

    await expect(
      refreshOrg2CloudAuthForAction(CURRENT, boundSetter(store))
    ).resolves.toEqual({ status: "ready", auth: LEASE });
    expect(store.get(org2CloudAuthAtom)).toBe(CURRENT);
  });

  it("clears the exact projection after native credential rejection", async () => {
    mocks.ensureFreshSession.mockImplementationOnce(
      async (_current, options) => {
        options?.onRefreshRejected?.();
        return null;
      }
    );
    const store = createStore();
    store.set(org2CloudAuthAtom, CURRENT);

    await expect(
      refreshOrg2CloudAuthForAction(CURRENT, boundSetter(store))
    ).resolves.toEqual({ status: "expired" });
    expect(store.get(org2CloudAuthAtom)).toBeNull();
  });

  it("keeps the projection on a retryable transport failure", async () => {
    mocks.ensureFreshSession.mockResolvedValueOnce(null);
    const store = createStore();
    store.set(org2CloudAuthAtom, CURRENT);

    await expect(
      refreshOrg2CloudAuthForAction(CURRENT, boundSetter(store))
    ).resolves.toEqual({ status: "unavailable" });
    expect(store.get(org2CloudAuthAtom)).toBe(CURRENT);
  });

  it("does not clear a newer generation after a late rejection", async () => {
    let rejectLate: (() => void) | undefined;
    mocks.ensureFreshSession.mockImplementationOnce(
      (_current, options) =>
        new Promise<null>((resolve) => {
          rejectLate = () => {
            options?.onRefreshRejected?.();
            resolve(null);
          };
        })
    );
    const store = createStore();
    store.set(org2CloudAuthAtom, CURRENT);
    const request = refreshOrg2CloudAuthForAction(CURRENT, boundSetter(store));
    const newer: Org2CloudAuthState = {
      ...CURRENT,
      sessionId: "00000000-0000-4000-8000-000000000002",
      generation: 2,
      userId: "user-2",
    };
    store.set(org2CloudAuthAtom, newer);
    rejectLate?.();

    await expect(request).resolves.toEqual({ status: "superseded" });
    expect(store.get(org2CloudAuthAtom)).toBe(newer);
  });
});
