const PENDING_PAIRING_KEY = "orgii:mobile-auth-v1:pending-pairing";
const OAUTH_ATTEMPT_KEY = "orgii:mobile-auth-v1:oauth-attempt";
const INTENT_TTL_MS = 10 * 60 * 1_000;

interface PendingPairingIntent {
  version: 1;
  raw: string;
  createdAtMs: number;
}

interface OAuthAttempt {
  version: 1;
  attemptId: string;
  createdAtMs: number;
}

function parseRecord<T extends { version: 1; createdAtMs: number }>(
  raw: string | null,
  nowMs: number
): T | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<T>;
    if (
      value.version !== 1 ||
      typeof value.createdAtMs !== "number" ||
      nowMs - value.createdAtMs < 0 ||
      nowMs - value.createdAtMs > INTENT_TTL_MS
    ) {
      return null;
    }
    return value as T;
  } catch {
    return null;
  }
}

/**
 * Capture a pairing link without decoding its credential-bearing payload.
 * The hash is scrubbed synchronously before any auth/network work begins.
 */
export function captureOpaquePairingIntent(
  location: Pick<Location, "href" | "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState" | "state">,
  storage: Pick<Storage, "setItem"> = sessionStorage,
  nowMs = Date.now()
): string | null {
  const hash = location.hash.startsWith("#")
    ? location.hash.slice(1)
    : location.hash;
  if (!new URLSearchParams(hash).has("pair")) return null;

  const intent: PendingPairingIntent = {
    version: 1,
    raw: location.href,
    createdAtMs: nowMs,
  };
  storage.setItem(PENDING_PAIRING_KEY, JSON.stringify(intent));
  history.replaceState(
    history.state,
    "",
    `${location.pathname}${location.search}`
  );
  return intent.raw;
}

export function consumeOpaquePairingIntent(
  storage: Pick<Storage, "getItem" | "removeItem"> = sessionStorage,
  nowMs = Date.now()
): string | null {
  const intent = parseRecord<PendingPairingIntent>(
    storage.getItem(PENDING_PAIRING_KEY),
    nowMs
  );
  storage.removeItem(PENDING_PAIRING_KEY);
  return intent && typeof intent.raw === "string" && intent.raw.length > 0
    ? intent.raw
    : null;
}

export function beginMobileOAuthAttempt(
  attemptId: string,
  storage: Pick<Storage, "setItem"> = sessionStorage,
  nowMs = Date.now()
): void {
  const attempt: OAuthAttempt = { version: 1, attemptId, createdAtMs: nowMs };
  storage.setItem(OAUTH_ATTEMPT_KEY, JSON.stringify(attempt));
}

export function consumeMobileOAuthAttempt(
  storage: Pick<Storage, "getItem" | "removeItem"> = sessionStorage,
  nowMs = Date.now()
): boolean {
  const attempt = parseRecord<OAuthAttempt>(
    storage.getItem(OAUTH_ATTEMPT_KEY),
    nowMs
  );
  storage.removeItem(OAUTH_ATTEMPT_KEY);
  return !!attempt && typeof attempt.attemptId === "string";
}

export function clearMobileAuthIntents(
  storage: Pick<Storage, "removeItem"> = sessionStorage
): void {
  storage.removeItem(PENDING_PAIRING_KEY);
  storage.removeItem(OAUTH_ATTEMPT_KEY);
}

export const MOBILE_AUTH_CALLBACK_PATH = "/orgii/mobile/auth/callback";

export function isMobileAuthCallback(
  location: Pick<Location, "pathname">
): boolean {
  return location.pathname.replace(/\/+$/, "") === MOBILE_AUTH_CALLBACK_PATH;
}
