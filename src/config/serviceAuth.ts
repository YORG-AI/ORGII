/**
 * Hosted service authentication configuration.
 *
 * Supabase Auth owns OAuth PKCE, session persistence, refresh, and sign-out.
 * This file keeps the app-level hosted-service token cache that existing
 * API clients and guards consume.
 */
import { isTauri } from "@tauri-apps/api/core";

/** True for both development and production builds hosted by Tauri. */
export const isTauriRuntime = (): boolean => isTauri();

export const isTauriProduction = (): boolean => {
  if (typeof window === "undefined") return false;
  return window.location.origin.startsWith("tauri://");
};

export const getCallbackUrl = (): string => {
  if (isTauriRuntime()) {
    return "yorgai://marketplace/callback";
  }
  return `${window.location.origin}/orgii/marketplace/callback`;
};

const DEFAULT_SUPABASE_URL = "https://fpdyejwbiriliuqqcjoy.supabase.co";
const DEFAULT_SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_FpHAgMYJFGb20HunqnhciA_-2nt9eYU";

export const SERVICE_AUTH_CONFIG = {
  supabaseUrl: process.env.REACT_APP_SUPABASE_URL || DEFAULT_SUPABASE_URL,
  supabasePublishableKey:
    process.env.REACT_APP_SUPABASE_PUBLISHABLE_KEY ||
    DEFAULT_SUPABASE_PUBLISHABLE_KEY,
  oauthProvider: "github",
  oauthScopes:
    process.env.REACT_APP_SUPABASE_OAUTH_SCOPES || "read:user user:email",
} as const;

const AUTH_SKIPPED_STORAGE_KEY = "orgii:auth_skipped";

export const HOSTED_LOGIN_ENABLED =
  process.env.REACT_APP_HOSTED_LOGIN_ENABLED === "true";

export function isAuthSkipped(): boolean {
  if (!HOSTED_LOGIN_ENABLED) return true;
  if (typeof window === "undefined") return false;
  return localStorage.getItem(AUTH_SKIPPED_STORAGE_KEY) === "1";
}

export function setAuthSkipped(skipped: boolean): void {
  if (skipped) {
    localStorage.setItem(AUTH_SKIPPED_STORAGE_KEY, "1");
  } else {
    localStorage.removeItem(AUTH_SKIPPED_STORAGE_KEY);
  }
}

export const HOSTED_SERVICE_API_CONFIG = {
  baseUrl: process.env.REACT_APP_MARKETPLACE_URL || "http://localhost:8001",
} as const;

export function parseAuthCallback(urlSearch: string): {
  code: string | null;
  error: string | null;
} {
  const params = new URLSearchParams(urlSearch);
  const error = params.get("error");
  if (error) {
    return {
      code: null,
      error: params.get("error_description") || error,
    };
  }

  const code = params.get("code");
  return {
    code,
    error: code ? null : "No authorization code in URL",
  };
}
