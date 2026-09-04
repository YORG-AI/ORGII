import { describe, expect, it, vi } from "vitest";

import type { MobileAuthSession } from "../../auth/mobileAuthState";
import type { MobileRemoteRuntimePort } from "../types";
import {
  TAURI_MOBILE_REMOTE_SECURE_KEYS,
  createTauriMobileRemotePlatformWithBridge,
} from "./tauriMobileRemotePlatform";
import type { TauriMobileRemoteBridge } from "./types";

const NOW_MS = 1_800_000_000_000;
const session: MobileAuthSession = {
  kind: "org2_cloud",
  supabaseUrl: "https://cloud.example.test",
  supabaseAnonKey: "anon-key",
  userId: "user-a",
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 1_900_000_000,
};

const runtime: MobileRemoteRuntimePort = {
  now: () => NOW_MS,
  random: () => 0.5,
  randomUUID: () => "00000000-0000-4000-8000-000000000001",
  setTimeout: () => 1,
  clearTimeout: () => undefined,
  isHidden: () => false,
  subscribeVisibility: () => () => undefined,
  portalContainer: () => null,
};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createMemoryBridge(
  initialUrls: string[] = [],
  subscriptionUrls: string[] = []
) {
  const secure = new Map<string, string>();
  const deepLinkListeners = new Set<(urls: string[]) => void>();
  const bridge: TauriMobileRemoteBridge = {
    openExternal: vi.fn().mockResolvedValue(undefined),
    secureRead: vi.fn(async (key) => secure.get(key) ?? null),
    secureWrite: vi.fn(async (key, value) => {
      secure.set(key, value);
    }),
    secureDelete: vi.fn(async (key) => {
      secure.delete(key);
    }),
    getInitialDeepLinks: vi.fn().mockResolvedValue(initialUrls),
    subscribeDeepLinks: vi.fn(async (listener) => {
      deepLinkListeners.add(listener);
      if (subscriptionUrls.length > 0) listener(subscriptionUrls);
      return () => deepLinkListeners.delete(listener);
    }),
  };
  return {
    bridge,
    secure,
    emitDeepLinks(urls: string[]) {
      for (const listener of deepLinkListeners) listener(urls);
    },
    listenerCount: () => deepLinkListeners.size,
  };
}

async function createPlatform(bridge: TauriMobileRemoteBridge) {
  return createTauriMobileRemotePlatformWithBridge({
    bridge,
    runtime,
    createSocket: vi.fn(() => ({ readyState: 0 }) as WebSocket),
    fetcher: vi.fn<typeof fetch>(),
  });
}

describe("createTauriMobileRemotePlatformWithBridge", () => {
  it("persists auth sessions in the injected Keychain boundary", async () => {
    const { bridge, secure } = createMemoryBridge();
    const { platform } = await createPlatform(bridge);

    await platform.auth.writeSession(session);
    await expect(platform.auth.readSession()).resolves.toEqual(session);
    expect(secure.get(TAURI_MOBILE_REMOTE_SECURE_KEYS.authSession)).toContain(
      '"accessToken":"access"'
    );

    await platform.auth.clearSession();
    await expect(platform.auth.readSession()).resolves.toBeNull();
  });

  it("propagates a system-browser opener failure to the auth gate", async () => {
    const { bridge } = createMemoryBridge();
    vi.mocked(bridge.openExternal).mockRejectedValue(
      new Error("System browser is unavailable")
    );
    const { platform } = await createPlatform(bridge);

    await expect(
      platform.auth.navigate("https://cloud.example.test/login")
    ).rejects.toThrow("System browser is unavailable");
  });

  it("serializes a pending session write before sign-out cleanup", async () => {
    const { bridge, secure } = createMemoryBridge();
    const writeStarted = deferred();
    const releaseWrite = deferred();
    vi.mocked(bridge.secureWrite).mockImplementationOnce(async (key, value) => {
      writeStarted.resolve();
      await releaseWrite.promise;
      secure.set(key, value);
    });
    const { platform } = await createPlatform(bridge);

    const pendingWrite = platform.auth.writeSession(session);
    await writeStarted.promise;
    const cleanup = platform.auth.clearSession();
    expect(bridge.secureDelete).not.toHaveBeenCalled();

    releaseWrite.resolve();
    await Promise.all([pendingWrite, cleanup]);
    expect(secure.has(TAURI_MOBILE_REMOTE_SECURE_KEYS.authSession)).toBe(false);
  });

  it("keeps the newest warm callback and notifies the mounted auth gate", async () => {
    const source = createMemoryBridge();
    const { platform, controller } = await createPlatform(source.bridge);
    const events: string[] = [];
    const unsubscribe = platform.auth.subscribeIntent((event) =>
      events.push(event)
    );

    source.emitDeepLinks([
      "org2remote://auth/callback?code=old",
      "org2remote://auth/callback?code=new",
    ]);

    expect(platform.auth.currentUrl()).toContain("code=new");
    expect(events).toEqual(["auth_callback", "auth_callback"]);
    unsubscribe();
    controller.dispose();
    expect(source.listenerCount()).toBe(0);
  });

  it("recovers cold and warm opaque pairing intents without decoding them", async () => {
    const coldPair = "org2remote://pair#pair=opaque-cold";
    const source = createMemoryBridge([coldPair]);
    const { platform } = await createPlatform(source.bridge);

    expect(platform.auth.captureInitialPairingIntent()).toBe(coldPair);
    await expect(platform.auth.consumePairingIntent()).resolves.toBe(coldPair);

    const events: string[] = [];
    platform.auth.subscribeIntent((event) => events.push(event));
    const warmPair = "org2remote://pair#pair=opaque-warm";
    source.emitDeepLinks([warmPair]);
    await expect(platform.auth.consumePairingIntent()).resolves.toBe(warmPair);
    expect(events).toEqual(["pairing"]);
    expect(platform.auth.currentUrl()).not.toContain("opaque-warm");
  });

  it("rejects callbacks and pair payloads from unowned schemes or hosts", async () => {
    const source = createMemoryBridge();
    const { controller, platform } = await createPlatform(source.bridge);
    const events: string[] = [];
    platform.auth.subscribeIntent((event) => events.push(event));

    expect(
      controller.acceptDeepLink("https://attacker.test/auth/callback?code=x")
    ).toBe(false);
    expect(
      controller.acceptDeepLink("org2remote://attacker/callback?code=x")
    ).toBe(false);
    expect(
      controller.acceptDeepLink("https://attacker.test/pair#pair=secret")
    ).toBe(false);
    expect(controller.acceptDeepLink("org2remote://attacker#pair=secret")).toBe(
      false
    );
    expect(events).toEqual([]);
    expect(platform.auth.captureInitialPairingIntent()).toBeNull();
  });

  it("deduplicates the same deep link delivered by subscription and cold start", async () => {
    const pairUrl = "org2remote://pair#pair=delivered-twice";
    const source = createMemoryBridge([pairUrl], [pairUrl]);
    const { platform, controller } = await createPlatform(source.bridge);

    expect(platform.auth.captureInitialPairingIntent()).toBe(pairUrl);
    expect(source.bridge.secureWrite).toHaveBeenCalledTimes(1);
    const events: string[] = [];
    platform.auth.subscribeIntent((event) => events.push(event));
    expect(controller.acceptDeepLink(pairUrl)).toBe(true);
    expect(events).toEqual([]);
  });

  it("keeps account-scoped inventory while active selection can be cleared", async () => {
    const { bridge } = createMemoryBridge();
    const { platform } = await createPlatform(bridge);

    await platform.connection.save("user/a", {
      wsUrl: "wss://relay.example/a",
      desktopId: "desktop-a",
      deviceLabel: "Home Mac",
      deviceToken: "secret-a",
    });
    await platform.connection.save("user/a", {
      wsUrl: "wss://relay.example/b",
      desktopId: "desktop-b",
      deviceLabel: "Office Mac",
      deviceToken: "secret-b",
    });

    await expect(platform.connection.load("user/a")).resolves.toMatchObject({
      desktopId: "desktop-b",
    });
    await expect(
      platform.connection.listPairedDesktops("user/a")
    ).resolves.toEqual([
      expect.objectContaining({ id: "desktop-b", active: true }),
      expect.objectContaining({ id: "desktop-a", active: false }),
    ]);
    await expect(
      platform.connection.listPairedDesktops("user-b")
    ).resolves.toEqual([]);

    await expect(
      platform.connection.selectPairedDesktop("user/a", "desktop-a")
    ).resolves.toMatchObject({
      desktopId: "desktop-a",
      deviceToken: "secret-a",
    });
    await expect(platform.connection.load("user/a")).resolves.toMatchObject({
      desktopId: "desktop-a",
    });
    await expect(
      platform.connection.listPairedDesktops("user/a")
    ).resolves.toEqual([
      expect.objectContaining({ id: "desktop-b", active: false }),
      expect.objectContaining({ id: "desktop-a", active: true }),
    ]);

    await platform.connection.save("user/a", null);
    await expect(platform.connection.load("user/a")).resolves.toBeNull();
    await expect(
      platform.connection.listPairedDesktops("user/a")
    ).resolves.toEqual([
      expect.objectContaining({ id: "desktop-b", active: false }),
      expect.objectContaining({ id: "desktop-a", active: false }),
    ]);
  });

  it("restores the active pairing after the platform is recreated", async () => {
    const source = createMemoryBridge();
    const first = await createPlatform(source.bridge);

    await first.platform.connection.save("local-development", {
      wsUrl: "wss://relay.example/a",
      desktopId: "desktop-a",
      deviceLabel: "Home Mac",
      deviceToken: "secret-a",
    });
    first.controller.dispose();

    const second = await createPlatform(source.bridge);
    await expect(
      second.platform.connection.load("local-development")
    ).resolves.toMatchObject({
      desktopId: "desktop-a",
      deviceLabel: "Home Mac",
      deviceToken: "secret-a",
    });
    second.controller.dispose();
  });

  it("serializes concurrent inventory writes so the last user selection wins", async () => {
    const { bridge, secure } = createMemoryBridge();
    const firstWriteStarted = deferred();
    const releaseFirstWrite = deferred();
    let inventoryWriteCount = 0;
    vi.mocked(bridge.secureWrite).mockImplementation(async (key, value) => {
      if (
        key.startsWith(TAURI_MOBILE_REMOTE_SECURE_KEYS.pairingInventoryPrefix)
      ) {
        inventoryWriteCount += 1;
        if (inventoryWriteCount === 1) {
          firstWriteStarted.resolve();
          await releaseFirstWrite.promise;
        }
      }
      secure.set(key, value);
    });
    const { platform } = await createPlatform(bridge);

    const firstSave = platform.connection.save("user-a", {
      wsUrl: "wss://relay.example/a",
      desktopId: "desktop-a",
      deviceToken: "secret-a",
    });
    await firstWriteStarted.promise;
    const secondSave = platform.connection.save("user-a", {
      wsUrl: "wss://relay.example/b",
      desktopId: "desktop-b",
      deviceToken: "secret-b",
    });
    expect(inventoryWriteCount).toBe(1);

    releaseFirstWrite.resolve();
    await Promise.all([firstSave, secondSave]);

    expect(inventoryWriteCount).toBe(2);
    await expect(platform.connection.load("user-a")).resolves.toMatchObject({
      desktopId: "desktop-b",
      deviceToken: "secret-b",
    });
    await expect(
      platform.connection.listPairedDesktops("user-a")
    ).resolves.toEqual([
      expect.objectContaining({ id: "desktop-b", active: true }),
      expect.objectContaining({ id: "desktop-a", active: false }),
    ]);
  });

  it("bounds retained local desktop inventory", async () => {
    const { bridge } = createMemoryBridge();
    const { platform } = await createPlatform(bridge);

    for (let index = 0; index < 25; index += 1) {
      await platform.connection.save("user-a", {
        wsUrl: `wss://relay.example/${index}`,
        desktopId: `desktop-${index}`,
      });
    }

    await expect(
      platform.connection.listPairedDesktops("user-a")
    ).resolves.toHaveLength(20);
  });
});
