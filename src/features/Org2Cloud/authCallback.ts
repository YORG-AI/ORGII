/**
 * Pure parsing for the `orgii://auth/callback` deep link that finishes the
 * ORG2 Cloud browser login (design §8):
 *
 *   orgii://auth/callback#access_token=<jwt>&refresh_token=<t>&expires_at=<s>
 *
 * The tokens ride in the URL FRAGMENT (never sent to any server by the
 * browser); the raw deep-link string delivered by the Tauri deep-link
 * plugin preserves the fragment, so we parse the part after `#` with
 * `URLSearchParams`.
 *
 * Kept free of React / Jotai / Tauri imports so it can be unit tested in
 * isolation — mirrors `src/store/collaboration/deepLink.ts`.
 */

export const ORG2_CLOUD_AUTH_DEEP_LINK_HOST = "auth";
export const ORG2_CLOUD_AUTH_DEEP_LINK_PATH = "callback";

export interface Org2CloudAuthCallback {
  accessToken: string;
  refreshToken: string;
  /** Unix epoch seconds, straight off the wire (`expires_at`). */
  expiresAt: number;
}

/**
 * Whether `url` is an `orgii://auth/callback` deep link (regardless of
 * whether its fragment is valid). Matched on the RAW `orgii://` url, BEFORE
 * the generic route normalization in useDeepLinkHandler turns it into
 * `/orgii/auth/callback` — same interception point as the collab links.
 */
export function isOrg2CloudAuthCallback(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith("orgii://")) return false;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    return (
      host === ORG2_CLOUD_AUTH_DEEP_LINK_HOST &&
      path === ORG2_CLOUD_AUTH_DEEP_LINK_PATH
    );
  } catch {
    return false;
  }
}

/**
 * Parse the fragment of an `orgii://auth/callback` deep link. Returns `null`
 * for anything that is not a complete, well-formed callback — wrong path, no
 * fragment, missing/empty token params, or a non-numeric `expires_at`.
 */
export function parseAuthCallbackFragment(
  url: string
): Org2CloudAuthCallback | null {
  if (!isOrg2CloudAuthCallback(url)) return null;
  const hashIndex = url.indexOf("#");
  if (hashIndex === -1) return null;
  const params = new URLSearchParams(url.slice(hashIndex + 1));
  const accessToken = params.get("access_token")?.trim();
  const refreshToken = params.get("refresh_token")?.trim();
  const expiresAtRaw = params.get("expires_at")?.trim();
  if (!accessToken || !refreshToken || !expiresAtRaw) return null;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;
  return { accessToken, refreshToken, expiresAt };
}

/**
 * Extract the Supabase user id (`sub` claim) from a JWT access token
 * WITHOUT verifying the signature — the deep-link fragment carries no
 * separate user id, and verification is the server's job (RLS re-checks the
 * token on every request). Returns `null` for anything malformed.
 */
export function decodeJwtSub(accessToken: string): string | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload: unknown = JSON.parse(atob(base64));
    if (
      payload !== null &&
      typeof payload === "object" &&
      "sub" in payload &&
      typeof (payload as { sub: unknown }).sub === "string" &&
      (payload as { sub: string }).sub.length > 0
    ) {
      return (payload as { sub: string }).sub;
    }
    return null;
  } catch {
    return null;
  }
}
