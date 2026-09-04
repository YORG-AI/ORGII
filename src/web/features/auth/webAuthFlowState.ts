const WEB_AUTH_STATE_BYTE_LENGTH = 32;
type WebAuthRandomBuffer = Uint8Array<ArrayBuffer>;

export const WEB_AUTH_STATE_STORAGE_KEY = "orgii:web-auth-state";

type WebAuthStateStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface CreateWebAuthCallbackUrlOptions {
  origin?: string;
  storage?: WebAuthStateStorage;
  fillRandom?: (buffer: WebAuthRandomBuffer) => WebAuthRandomBuffer;
}

interface ValidateWebAuthCallbackStateOptions {
  origin?: string;
  storage?: WebAuthStateStorage;
}

function browserStorage(): WebAuthStateStorage {
  return window.sessionStorage;
}

function browserRandom(buffer: WebAuthRandomBuffer): WebAuthRandomBuffer {
  return window.crypto.getRandomValues(buffer);
}

function randomState(
  fillRandom: (buffer: WebAuthRandomBuffer) => WebAuthRandomBuffer
): string {
  const bytes = fillRandom(new Uint8Array(WEB_AUTH_STATE_BYTE_LENGTH));
  if (bytes.length !== WEB_AUTH_STATE_BYTE_LENGTH) {
    throw new Error("Web auth state generator returned the wrong byte length");
  }
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    ""
  );
}

/** Start one browser sign-in episode and bind its callback to this tab. */
export function createWebAuthCallbackUrl(
  options: CreateWebAuthCallbackUrlOptions = {}
): string {
  const origin = options.origin ?? window.location.origin;
  const storage = options.storage ?? browserStorage();
  const state = randomState(options.fillRandom ?? browserRandom);
  storage.setItem(WEB_AUTH_STATE_STORAGE_KEY, state);

  const callbackUrl = new URL("/auth/callback", origin);
  callbackUrl.searchParams.set("state", state);
  return callbackUrl.toString();
}

export interface ValidatedWebAuthCallbackState {
  expectedCallbackUrl: string;
  state: string;
}

/**
 * Correlate a callback with the sign-in episode started in this tab.
 * Consumption is separate so malformed credentials cannot burn a valid state.
 */
export function validateWebAuthCallbackState(
  callbackHref: string,
  options: ValidateWebAuthCallbackStateOptions = {}
): ValidatedWebAuthCallbackState | null {
  const origin = options.origin ?? window.location.origin;
  const storage = options.storage ?? browserStorage();
  const expectedState = storage.getItem(WEB_AUTH_STATE_STORAGE_KEY);
  if (!expectedState) return null;

  let callbackUrl: URL;
  try {
    callbackUrl = new URL(callbackHref);
  } catch {
    return null;
  }
  const callbackStates = callbackUrl.searchParams.getAll("state");
  if (callbackStates.length !== 1 || callbackStates[0] !== expectedState) {
    return null;
  }

  const expectedCallbackUrl = new URL("/auth/callback", origin);
  expectedCallbackUrl.searchParams.set("state", expectedState);
  return {
    expectedCallbackUrl: expectedCallbackUrl.toString(),
    state: expectedState,
  };
}

/** Consume a previously validated state exactly once. */
export function consumeWebAuthCallbackState(
  expectedState: string,
  storage: WebAuthStateStorage = browserStorage()
): boolean {
  if (storage.getItem(WEB_AUTH_STATE_STORAGE_KEY) !== expectedState) {
    return false;
  }
  storage.removeItem(WEB_AUTH_STATE_STORAGE_KEY);
  return true;
}
