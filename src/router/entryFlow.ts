import { ROUTES } from "@src/config/routes";
import type { SetupWalkthroughOutcome } from "@src/store/settings/setupWalkthroughHydration";

export const LOGIN_REDIRECT_STORAGE_KEY = "login_redirect";
export const SETUP_RETURN_QUERY_KEY = "continue";

export interface AppLocationLike {
  pathname: string;
  search?: string;
  hash?: string;
}

function toLocationPath(location: AppLocationLike): string {
  return `${location.pathname}${location.search ?? ""}${location.hash ?? ""}`;
}

function normalizeInternalPath(
  candidate: string | null | undefined
): string | null {
  if (!candidate?.startsWith("/")) return null;

  try {
    const base = new URL("https://orgii.local");
    const url = new URL(candidate, base);
    if (url.origin !== base.origin) return null;
    if (url.pathname !== "/orgii" && !url.pathname.startsWith("/orgii/")) {
      return null;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function isPublicAuthDestination(path: string): boolean {
  const pathname = new URL(path, "https://orgii.local").pathname;
  return (
    pathname === ROUTES.auth.login.path ||
    pathname === ROUTES.app.market.callback.path
  );
}

export function resolvePostAuthRedirect(
  candidate?: string | AppLocationLike | null
): string {
  const path =
    typeof candidate === "string"
      ? normalizeInternalPath(candidate)
      : candidate
        ? normalizeInternalPath(toLocationPath(candidate))
        : null;

  if (!path || isPublicAuthDestination(path)) {
    return ROUTES.workStation.base.path;
  }
  return path;
}

export function readLoginRedirect(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = sessionStorage.getItem(LOGIN_REDIRECT_STORAGE_KEY);
    return stored ? resolvePostAuthRedirect(stored) : null;
  } catch {
    return null;
  }
}

export function storeLoginRedirect(path: string): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(
      LOGIN_REDIRECT_STORAGE_KEY,
      resolvePostAuthRedirect(path)
    );
  } catch {
    // Session storage may be unavailable in hardened WebViews.
  }
}

export function consumeLoginRedirect(): string {
  const redirect = readLoginRedirect() ?? ROUTES.workStation.base.path;
  if (typeof window !== "undefined") {
    try {
      sessionStorage.removeItem(LOGIN_REDIRECT_STORAGE_KEY);
    } catch {
      // Session storage may be unavailable in hardened WebViews.
    }
  }
  return redirect;
}

function isSetupReturnDestination(path: string): boolean {
  const pathname = new URL(path, "https://orgii.local").pathname;
  return !isPublicAuthDestination(path) && pathname !== ROUTES.auth.setup.path;
}

export function buildSetupEntryPath(
  returnTo?: AppLocationLike | string
): string {
  if (!returnTo) return ROUTES.auth.setup.path;
  const candidate =
    typeof returnTo === "string" ? returnTo : toLocationPath(returnTo);
  const normalized = normalizeInternalPath(candidate);
  if (!normalized || !isSetupReturnDestination(normalized)) {
    return ROUTES.auth.setup.path;
  }

  const query = new URLSearchParams({
    [SETUP_RETURN_QUERY_KEY]: normalized,
  });
  return `${ROUTES.auth.setup.path}?${query.toString()}`;
}

export function resolveSetupReturnPath(search: string): string {
  const candidate = new URLSearchParams(search).get(SETUP_RETURN_QUERY_KEY);
  const normalized = normalizeInternalPath(candidate);
  if (!normalized || !isSetupReturnDestination(normalized)) {
    return ROUTES.workStation.base.path;
  }
  return normalized;
}

export function shouldAutoOpenSetup(input: {
  settingsLoaded: boolean;
  rawSettings: Record<string, unknown> | null;
  outcome: SetupWalkthroughOutcome;
}): boolean {
  return (
    input.settingsLoaded &&
    input.rawSettings !== null &&
    input.outcome === "open"
  );
}
