/**
 * Ephemeral loopback receiver for ORG2 Cloud browser sign-in.
 *
 * A bare `tauri dev` executable is not a macOS application bundle, so it
 * cannot own the `orgii://` URL scheme through LaunchServices. The OAuth
 * plugin gives browser-initiated sign-in a bundle-independent return path:
 * it listens on 127.0.0.1 and preserves the browser URL fragment through its
 * `/cb` hand-off before emitting `oauth://url` to the app.
 *
 * Only one cloud flow may be pending. It is replaced on a new sign-in,
 * expires after ten minutes, and is cleared as soon as its callback is
 * consumed. The global deep-link hook owns the app-lifetime event listener;
 * this module owns only the short-lived loopback server and expiry timer.
 */
import {
  cancel as cancelOAuthServer,
  start as startOAuthServer,
} from "@fabianlars/tauri-plugin-oauth";

export const ORG2_CLOUD_AUTH_LOOPBACK_PATH = "/org2-cloud/auth/callback";
export const ORG2_CLOUD_AUTH_LOOPBACK_TTL_MS = 10 * 60 * 1000;
export const ORG2_CLOUD_PENDING_AUTH_STORAGE_KEY =
  "orgii:org2-cloud-v1:pendingAuthLoopback";

export interface PendingOrg2CloudAuthLoopback {
  callbackUrl: string;
  port: number;
  expiresAtMs: number;
}

interface OAuthLoopbackApi {
  start: (config?: { response?: string }) => Promise<number>;
  cancel: (port: number) => Promise<void>;
}

interface BeginLoopbackOptions {
  api?: OAuthLoopbackApi;
  storage?: Storage;
  now?: () => number;
  createState?: () => string;
}

let expiryTimer: ReturnType<typeof setTimeout> | null = null;

const AUTH_STATE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DEFAULT_OAUTH_API: OAuthLoopbackApi = {
  start: startOAuthServer,
  cancel: cancelOAuthServer,
};

const CALLBACK_RESPONSE = `
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>ORG2 Cloud sign-in</title></head>
  <body style="font-family: system-ui; text-align: center; padding: 48px">
    <p>You are signed in. You can close this tab and return to ORG2.</p>
  </body>
</html>`;

function defaultStorage(): Storage {
  return window.sessionStorage;
}

function defaultState(): string {
  return crypto.randomUUID();
}

export function buildOrg2CloudAuthLoopbackUrl(
  port: number,
  state: string
): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("invalid ORG2 Cloud auth loopback port");
  }
  if (!AUTH_STATE_PATTERN.test(state)) {
    throw new Error("invalid ORG2 Cloud auth loopback state");
  }
  const url = new URL(
    ORG2_CLOUD_AUTH_LOOPBACK_PATH,
    `http://localhost:${port}`
  );
  url.searchParams.set("state", state);
  return url.toString();
}

export function isOrg2CloudAuthLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const state = url.searchParams.get("state");
    return (
      url.protocol === "http:" &&
      url.hostname === "localhost" &&
      Number.isInteger(Number(url.port)) &&
      Number(url.port) >= 1 &&
      Number(url.port) <= 65_535 &&
      url.pathname === ORG2_CLOUD_AUTH_LOOPBACK_PATH &&
      url.searchParams.size === 1 &&
      state !== null &&
      AUTH_STATE_PATTERN.test(state) &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function readPendingOrg2CloudAuthLoopback(
  storage: Storage = defaultStorage()
): PendingOrg2CloudAuthLoopback | null {
  const raw = storage.getItem(ORG2_CLOUD_PENDING_AUTH_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingOrg2CloudAuthLoopback>;
    if (
      typeof parsed.callbackUrl !== "string" ||
      !isOrg2CloudAuthLoopbackUrl(parsed.callbackUrl) ||
      !Number.isInteger(parsed.port) ||
      (parsed.port ?? 0) < 1 ||
      (parsed.port ?? 0) > 65_535 ||
      typeof parsed.expiresAtMs !== "number" ||
      !Number.isFinite(parsed.expiresAtMs) ||
      new URL(parsed.callbackUrl).port !== String(parsed.port)
    ) {
      return null;
    }
    return parsed as PendingOrg2CloudAuthLoopback;
  } catch {
    return null;
  }
}

function clearExpiryTimer(): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
}

export function completePendingOrg2CloudAuthLoopback(
  storage: Storage = defaultStorage()
): void {
  clearExpiryTimer();
  storage.removeItem(ORG2_CLOUD_PENDING_AUTH_STORAGE_KEY);
}

export async function cancelPendingOrg2CloudAuthLoopback(
  options: Pick<BeginLoopbackOptions, "api" | "storage"> = {}
): Promise<void> {
  const api = options.api ?? DEFAULT_OAUTH_API;
  const storage = options.storage ?? defaultStorage();
  const pending = readPendingOrg2CloudAuthLoopback(storage);
  completePendingOrg2CloudAuthLoopback(storage);
  if (!pending) return;
  try {
    await api.cancel(pending.port);
  } catch {
    // The helper closes itself after a callback and the app process owns it;
    // an already-closed port is equivalent to a successful cancellation.
  }
}

export function schedulePendingOrg2CloudAuthLoopbackExpiry(
  options: Pick<BeginLoopbackOptions, "api" | "storage" | "now"> = {}
): void {
  clearExpiryTimer();
  const storage = options.storage ?? defaultStorage();
  const pending = readPendingOrg2CloudAuthLoopback(storage);
  if (!pending) return;
  const now = options.now ?? Date.now;
  const remainingMs = Math.min(
    ORG2_CLOUD_AUTH_LOOPBACK_TTL_MS,
    Math.max(0, pending.expiresAtMs - now())
  );
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    void cancelPendingOrg2CloudAuthLoopback(options);
  }, remainingMs);
}

export async function beginOrg2CloudAuthLoopback(
  options: BeginLoopbackOptions = {}
): Promise<string> {
  const api = options.api ?? DEFAULT_OAUTH_API;
  const storage = options.storage ?? defaultStorage();
  const now = options.now ?? Date.now;
  const createState = options.createState ?? defaultState;

  await cancelPendingOrg2CloudAuthLoopback({ api, storage });

  const port = await api.start({ response: CALLBACK_RESPONSE });
  try {
    const callbackUrl = buildOrg2CloudAuthLoopbackUrl(port, createState());
    const pending: PendingOrg2CloudAuthLoopback = {
      callbackUrl,
      port,
      expiresAtMs: now() + ORG2_CLOUD_AUTH_LOOPBACK_TTL_MS,
    };
    storage.setItem(
      ORG2_CLOUD_PENDING_AUTH_STORAGE_KEY,
      JSON.stringify(pending)
    );
    schedulePendingOrg2CloudAuthLoopbackExpiry({ api, storage, now });
    return callbackUrl;
  } catch (error) {
    try {
      await api.cancel(port);
    } catch {
      // Preserve the original setup failure.
    }
    throw error;
  }
}
