import type { MobileAuthSession } from "../../auth/mobileAuthState";
import {
  activePairingConfig,
  parsePairingInventory,
  selectPairingInventory,
  summarizePairingInventory,
  updatePairingInventory,
} from "../../connection/mobilePairedDesktopInventory";
import type {
  MobileRemoteIntentEvent,
  MobileRemotePlatform,
  MobileRemoteRuntimePort,
} from "../types";
import { createTauriMobileAuthClient } from "./tauriMobileAuthClient";
import type {
  TauriMobileRemoteBridge,
  TauriMobileRemoteController,
  TauriMobileRemotePlatformOptions,
} from "./types";

const AUTH_SESSION_KEY = "org2.remote.auth.session.v1";
const OAUTH_ATTEMPT_KEY = "org2.remote.auth.oauth-attempt.v1";
const PAIRING_INTENT_KEY = "org2.remote.auth.pairing-intent.v1";
const PAIRING_INVENTORY_PREFIX = "org2.remote.pairing-inventory.v1:";
const INTENT_TTL_MS = 10 * 60 * 1_000;
const MAX_RECENT_DEEP_LINKS = 16;
const DEEP_LINK_DEDUPE_TTL_MS = 60_000;
const DEFAULT_CALLBACK_URL = "org2remote://auth/callback";
const DEFAULT_HOME_URL = "org2remote://";

interface StoredIntent {
  version: 1;
  value: string;
  createdAtMs: number;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseIntent(raw: string | null, nowMs: number): StoredIntent | null {
  const value = parseJson<Partial<StoredIntent>>(raw);
  if (
    value?.version !== 1 ||
    typeof value.value !== "string" ||
    !value.value ||
    typeof value.createdAtMs !== "number" ||
    nowMs < value.createdAtMs ||
    nowMs - value.createdAtMs > INTENT_TTL_MS
  ) {
    return null;
  }
  return value as StoredIntent;
}

function isAuthCallback(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "org2remote:" &&
      url.hostname === "auth" &&
      url.pathname.replace(/\/+$/u, "") === "/callback"
    );
  } catch {
    return false;
  }
}

function hasOpaquePairPayload(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "org2remote:" || url.hostname !== "pair") {
      return false;
    }
    const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    return !!(
      url.searchParams.get("pair")?.trim() ||
      new URLSearchParams(hash).get("pair")?.trim()
    );
  } catch {
    return false;
  }
}

function inventoryKey(userId: string): string {
  return `${PAIRING_INVENTORY_PREFIX}${encodeURIComponent(userId)}`;
}

function isAuthSession(value: unknown): value is MobileAuthSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<MobileAuthSession>;
  return (
    session.kind === "org2_cloud" &&
    typeof session.userId === "string" &&
    !!session.userId &&
    typeof session.accessToken === "string" &&
    !!session.accessToken &&
    typeof session.refreshToken === "string" &&
    !!session.refreshToken &&
    typeof session.expiresAt === "number"
  );
}

export interface CreatedTauriMobileRemotePlatform {
  platform: MobileRemotePlatform;
  controller: TauriMobileRemoteController;
}

/** Injected factory used by tests and alternate native shells. */
export async function createTauriMobileRemotePlatformWithBridge({
  bridge,
  runtime,
  createSocket,
  fetcher = globalThis.fetch.bind(globalThis),
  callbackUrl = DEFAULT_CALLBACK_URL,
  homeUrl = DEFAULT_HOME_URL,
  clientInfo = {
    name: "org2-remote-ios",
    version: "0.1.0",
    defaultDeviceLabel: "ORG2 Remote for iPhone",
  },
}: TauriMobileRemotePlatformOptions): Promise<CreatedTauriMobileRemotePlatform> {
  let currentUrl = homeUrl;
  let pendingPairing: StoredIntent | null = null;
  let secureMutationChain = Promise.resolve();
  let nativeUnsubscribe: (() => void) | null = null;
  let disposed = false;
  const intentListeners = new Set<(event: MobileRemoteIntentEvent) => void>();
  const recentDeepLinks = new Map<string, number>();

  const mutateSecure = <T>(operation: () => Promise<T>): Promise<T> => {
    const mutation = secureMutationChain.then(operation);
    secureMutationChain = mutation.then(
      () => undefined,
      () => undefined
    );
    return mutation;
  };
  const afterMutations = async () => {
    await secureMutationChain;
  };
  const storeIntent = (key: string, value: StoredIntent) =>
    mutateSecure(() => bridge.secureWrite(key, JSON.stringify(value)));
  const notifyIntent = (event: MobileRemoteIntentEvent) => {
    for (const listener of intentListeners) listener(event);
  };
  const isDuplicateDeepLink = (url: string) => {
    const nowMs = runtime.now();
    for (const [candidate, seenAtMs] of recentDeepLinks) {
      if (nowMs - seenAtMs > DEEP_LINK_DEDUPE_TTL_MS) {
        recentDeepLinks.delete(candidate);
      }
    }
    if (recentDeepLinks.has(url)) return true;
    recentDeepLinks.set(url, nowMs);
    while (recentDeepLinks.size > MAX_RECENT_DEEP_LINKS) {
      const oldest = recentDeepLinks.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      recentDeepLinks.delete(oldest);
    }
    return false;
  };
  const readInventory = async (userId: string) => {
    await afterMutations();
    return parsePairingInventory(await bridge.secureRead(inventoryKey(userId)));
  };

  const controller: TauriMobileRemoteController = {
    acceptDeepLink(url) {
      if (disposed) return false;
      if (hasOpaquePairPayload(url)) {
        if (isDuplicateDeepLink(url)) return true;
        pendingPairing = {
          version: 1,
          value: url,
          createdAtMs: runtime.now(),
        };
        void storeIntent(PAIRING_INTENT_KEY, pendingPairing).catch(
          () => undefined
        );
        currentUrl = homeUrl;
        notifyIntent("pairing");
        return true;
      }
      if (isAuthCallback(url)) {
        if (isDuplicateDeepLink(url)) return true;
        currentUrl = url;
        notifyIntent("auth_callback");
        return true;
      }
      return false;
    },
    dispose() {
      disposed = true;
      nativeUnsubscribe?.();
      nativeUnsubscribe = null;
      intentListeners.clear();
      recentDeepLinks.clear();
    },
  };

  const platform: MobileRemotePlatform = {
    kind: "ios",
    clientInfo,
    runtime,
    auth: {
      createClient: () => createTauriMobileAuthClient({ bridge, fetcher }),
      captureInitialPairingIntent() {
        return pendingPairing?.value ?? null;
      },
      isCallback: () => isAuthCallback(currentUrl),
      currentUrl: () => currentUrl,
      callbackUrl: () => callbackUrl,
      scrubCallback: () => {
        currentUrl = homeUrl;
      },
      navigate: (url) => {
        return bridge.openExternal(url);
      },
      beginOAuthAttempt(attemptId) {
        return storeIntent(OAUTH_ATTEMPT_KEY, {
          version: 1,
          value: attemptId,
          createdAtMs: runtime.now(),
        });
      },
      async consumeOAuthAttempt() {
        await afterMutations();
        const attempt = parseIntent(
          await bridge.secureRead(OAUTH_ATTEMPT_KEY),
          runtime.now()
        );
        await mutateSecure(() => bridge.secureDelete(OAUTH_ATTEMPT_KEY));
        return !!attempt;
      },
      async consumePairingIntent() {
        await afterMutations();
        const intent =
          pendingPairing ??
          parseIntent(
            await bridge.secureRead(PAIRING_INTENT_KEY),
            runtime.now()
          );
        pendingPairing = null;
        await mutateSecure(() => bridge.secureDelete(PAIRING_INTENT_KEY));
        return intent?.value ?? null;
      },
      clearIntents() {
        pendingPairing = null;
        return mutateSecure(async () => {
          await bridge.secureDelete(OAUTH_ATTEMPT_KEY);
          await bridge.secureDelete(PAIRING_INTENT_KEY);
        });
      },
      async readSession() {
        await afterMutations();
        const session = parseJson<unknown>(
          await bridge.secureRead(AUTH_SESSION_KEY)
        );
        return isAuthSession(session) ? session : null;
      },
      writeSession(session) {
        return mutateSecure(() =>
          bridge.secureWrite(AUTH_SESSION_KEY, JSON.stringify(session))
        );
      },
      clearSession() {
        return mutateSecure(() => bridge.secureDelete(AUTH_SESSION_KEY));
      },
      subscribeIntent(listener) {
        intentListeners.add(listener);
        return () => intentListeners.delete(listener);
      },
    },
    connection: {
      createSocket,
      async load(userId) {
        if (!userId.trim()) return null;
        const inventory = await readInventory(userId);
        return activePairingConfig(inventory);
      },
      async listPairedDesktops(userId) {
        if (!userId.trim()) return [];
        return summarizePairingInventory(await readInventory(userId));
      },
      async selectPairedDesktop(userId, desktopId) {
        if (!userId.trim() || !desktopId.trim()) return null;
        return mutateSecure(async () => {
          const key = inventoryKey(userId);
          const selected = selectPairingInventory(
            parsePairingInventory(await bridge.secureRead(key)),
            desktopId
          );
          if (!selected) return null;
          await bridge.secureWrite(key, JSON.stringify(selected.inventory));
          return selected.config;
        });
      },
      save(userId, config) {
        if (!userId.trim()) return Promise.resolve();
        return mutateSecure(async () => {
          const key = inventoryKey(userId);
          const inventory = parsePairingInventory(await bridge.secureRead(key));
          const nextInventory = updatePairingInventory(
            inventory,
            config,
            runtime.now()
          );
          if (config || inventory.desktops.length > 0) {
            await bridge.secureWrite(key, JSON.stringify(nextInventory));
          }
        });
      },
    },
  };

  nativeUnsubscribe = await bridge.subscribeDeepLinks((urls) => {
    for (const url of urls) controller.acceptDeepLink(url);
  });
  const initialUrls = await bridge.getInitialDeepLinks();
  for (const url of initialUrls) controller.acceptDeepLink(url);

  return { platform, controller };
}

function createDefaultRuntime(): MobileRemoteRuntimePort {
  return {
    now: () => Date.now(),
    random: () => Math.random(),
    randomUUID: () => globalThis.crypto.randomUUID(),
    setTimeout: (callback, delayMs) =>
      globalThis.document.defaultView!.setTimeout(callback, delayMs),
    clearTimeout: (timeoutId) =>
      globalThis.document.defaultView!.clearTimeout(timeoutId),
    isHidden: () => globalThis.document.hidden,
    subscribeVisibility(listener) {
      globalThis.document.addEventListener("visibilitychange", listener);
      return () =>
        globalThis.document.removeEventListener("visibilitychange", listener);
    },
  };
}

async function createDefaultBridge(): Promise<TauriMobileRemoteBridge> {
  const [{ invoke }, { getCurrent, onOpenUrl }, { openUrl }] =
    await Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/plugin-deep-link"),
      import("@tauri-apps/plugin-opener"),
    ]);
  return {
    openExternal: (url) => openUrl(url),
    async secureRead(key) {
      return invoke<string | null>("mobile_keychain_read", { key });
    },
    async secureWrite(key, value) {
      await invoke("mobile_keychain_write", { key, value });
    },
    async secureDelete(key) {
      await invoke("mobile_keychain_delete", { key });
    },
    async getInitialDeepLinks() {
      return (await getCurrent()) ?? [];
    },
    subscribeDeepLinks: (listener) => onOpenUrl(listener),
  };
}

/** Production entry point used by the iOS shell. */
export async function createTauriMobileRemotePlatform(): Promise<MobileRemotePlatform> {
  const bridge = await createDefaultBridge();
  const { platform, controller } =
    await createTauriMobileRemotePlatformWithBridge({
      bridge,
      runtime: createDefaultRuntime(),
      createSocket: (url) => new globalThis.WebSocket(url),
      fetcher: globalThis.fetch.bind(globalThis),
    });
  globalThis.document.defaultView!.addEventListener(
    "pagehide",
    () => controller.dispose(),
    { once: true }
  );
  return platform;
}

export const TAURI_MOBILE_REMOTE_SECURE_KEYS = {
  authSession: AUTH_SESSION_KEY,
  oauthAttempt: OAUTH_ATTEMPT_KEY,
  pairingIntent: PAIRING_INTENT_KEY,
  pairingInventoryPrefix: PAIRING_INVENTORY_PREFIX,
} as const;
