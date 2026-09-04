// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";

import { useMobileRelayCloudAuthSync } from "../useMobileRelayCloudAuthSync";

const mocks = vi.hoisted(() => ({
  ensureFreshSession: vi.fn(),
  awaitMirroredOrg2CloudAuth: vi.fn(),
  notifyCloudAuthChanged: vi.fn(),
  listen: vi.fn(),
  settings: new Map<string, unknown>([
    ["mobileRemote.enabled", true],
    ["mobileRemote.relayEnabled", true],
  ]),
}));

vi.mock("@src/features/Org2Cloud/org2CloudClient", () => ({
  ensureFreshSession: mocks.ensureFreshSession,
}));

vi.mock("@src/api/http/auth/sharedAuthStorage", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@src/api/http/auth/sharedAuthStorage")
    >();
  return {
    ...actual,
    awaitMirroredOrg2CloudAuth: mocks.awaitMirroredOrg2CloudAuth,
  };
});

vi.mock("@src/api/tauri/mobileRemote", () => ({
  notifyCloudAuthChanged: mocks.notifyCloudAuthChanged,
}));

vi.mock("@src/hooks/settings/useSettings", () => ({
  useSetting: (key: string) => {
    const value = mocks.settings.get(key);
    return [value, vi.fn()] as const;
  },
}));

vi.mock("@src/hooks/platform/useTauriListen", () => ({
  useTauriListen: mocks.listen,
}));

const AUTH = {
  kind: "org2_cloud" as const,
  supabaseUrl: "https://example.supabase.co",
  supabaseAnonKey: "anon",
  userId: "user-1",
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: 4_102_444_800,
};

function HookProbe() {
  useMobileRelayCloudAuthSync();
  return null;
}

describe("useMobileRelayCloudAuthSync", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.ensureFreshSession.mockReset();
    mocks.awaitMirroredOrg2CloudAuth.mockReset();
    mocks.notifyCloudAuthChanged.mockReset();
    mocks.listen.mockReset();
    mocks.settings.set("mobileRemote.enabled", true);
    mocks.settings.set("mobileRemote.relayEnabled", true);
    mocks.ensureFreshSession.mockImplementation(
      async (auth: typeof AUTH) => auth
    );
    mocks.awaitMirroredOrg2CloudAuth.mockResolvedValue(undefined);
    mocks.notifyCloudAuthChanged.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  it("notifies Rust when cloud auth is missing", async () => {
    const store = createStore();

    await act(async () => {
      root.render(
        React.createElement(Provider, { store }, React.createElement(HookProbe))
      );
      await Promise.resolve();
    });

    expect(mocks.awaitMirroredOrg2CloudAuth).toHaveBeenCalledWith(null);
    expect(mocks.notifyCloudAuthChanged).toHaveBeenCalled();
    expect(mocks.ensureFreshSession).not.toHaveBeenCalled();
  });

  it("refreshes auth, mirrors to shared store, then notifies Rust when signed in", async () => {
    const store = createStore();
    store.set(org2CloudAuthAtom, AUTH);

    await act(async () => {
      root.render(
        React.createElement(Provider, { store }, React.createElement(HookProbe))
      );
      await Promise.resolve();
    });

    expect(mocks.ensureFreshSession).toHaveBeenCalledWith(AUTH);
    expect(mocks.awaitMirroredOrg2CloudAuth).toHaveBeenCalledWith(
      JSON.stringify(AUTH)
    );
    expect(mocks.notifyCloudAuthChanged).toHaveBeenCalled();
  });

  it("mirrors auth to the shared store before notifying Rust", async () => {
    const store = createStore();
    store.set(org2CloudAuthAtom, AUTH);

    await act(async () => {
      root.render(
        React.createElement(Provider, { store }, React.createElement(HookProbe))
      );
      await Promise.resolve();
    });

    for (
      let index = 0;
      index < mocks.notifyCloudAuthChanged.mock.calls.length;
      index++
    ) {
      expect(
        mocks.awaitMirroredOrg2CloudAuth.mock.invocationCallOrder[index]
      ).toBeLessThan(
        mocks.notifyCloudAuthChanged.mock.invocationCallOrder[index]
      );
    }
  });

  it("does nothing while relay is disabled", async () => {
    mocks.settings.set("mobileRemote.relayEnabled", false);
    const store = createStore();
    store.set(org2CloudAuthAtom, AUTH);

    await act(async () => {
      root.render(
        React.createElement(Provider, { store }, React.createElement(HookProbe))
      );
      await Promise.resolve();
    });

    expect(mocks.ensureFreshSession).not.toHaveBeenCalled();
    expect(mocks.awaitMirroredOrg2CloudAuth).not.toHaveBeenCalled();
    expect(mocks.notifyCloudAuthChanged).not.toHaveBeenCalled();
  });
});
