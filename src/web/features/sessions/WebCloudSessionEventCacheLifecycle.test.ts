/** @vitest-environment jsdom */
import { Provider, createStore } from "jotai";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type Org2CloudAuthState,
  org2CloudAuthAtom,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { createSmokeRoot, dispatch } from "@src/test/reactSmokeHarness";

import { WebCloudSessionEventCacheLifecycle } from "./WebCloudSessionEventCacheLifecycle";

const mocks = vi.hoisted(() => ({ clearCache: vi.fn() }));

vi.mock("./webCloudSessionEventCache", () => ({
  clearWebCloudSessionEventCache: () => mocks.clearCache(),
}));

function auth(
  userId: string,
  overrides: Partial<Org2CloudAuthState> = {}
): Org2CloudAuthState {
  return {
    kind: "org2_cloud",
    supabaseUrl: "https://cloud.example.test",
    supabaseAnonKey: "anon",
    userId,
    accessToken: `access-${userId}`,
    refreshToken: `refresh-${userId}`,
    expiresAt: 4_102_444_800,
    ...overrides,
  };
}

describe("WebCloudSessionEventCacheLifecycle", () => {
  const roots: Array<ReturnType<typeof createSmokeRoot>> = [];

  beforeEach(() => mocks.clearCache.mockReset().mockResolvedValue(undefined));

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => root.unmount()));
  });

  it("clears stale snapshots when Web starts signed out", async () => {
    const root = createSmokeRoot();
    roots.push(root);
    await root.render(
      React.createElement(
        Provider,
        { store: createStore() },
        React.createElement(WebCloudSessionEventCacheLifecycle)
      )
    );

    expect(mocks.clearCache).toHaveBeenCalledOnce();
  });

  it("preserves refreshes but clears sign-out and identity switches", async () => {
    const store = createStore();
    store.set(org2CloudAuthAtom, auth("user-1"));
    const root = createSmokeRoot();
    roots.push(root);
    await root.render(
      React.createElement(
        Provider,
        { store },
        React.createElement(WebCloudSessionEventCacheLifecycle)
      )
    );
    expect(mocks.clearCache).not.toHaveBeenCalled();

    await dispatch(() => {
      store.set(
        org2CloudAuthAtom,
        auth("user-1", {
          accessToken: "rotated-access",
          refreshToken: "rotated-refresh",
        })
      );
    });
    expect(mocks.clearCache).not.toHaveBeenCalled();

    await dispatch(() => store.set(org2CloudAuthAtom, auth("user-2")));
    expect(mocks.clearCache).toHaveBeenCalledTimes(1);

    await dispatch(() => store.set(org2CloudAuthAtom, null));
    expect(mocks.clearCache).toHaveBeenCalledTimes(2);
  });
});
