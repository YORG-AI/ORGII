/**
 * Hosted service authentication configuration.
 *
 * Supabase Auth owns OAuth PKCE, session persistence, refresh, and sign-out.
 * This file keeps the app-level hosted-service token cache that existing
 * API clients and guards consume.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * True whenever the frontend is hosted by Tauri, including `tauri dev` where
 * the page origin is HTTP. OAuth uses this signal so development and release
 * builds both leave the app WebView and authenticate in the system browser.
 */
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

export const SERVICE_AUTH_STORAGE_KEYS = {
  accessToken: "hosted_access_token",
  refreshToken: "hosted_refresh_token",
  tokenExpiry: "hosted_token_expiry",
  userId: "hosted_user_id",
  authSkipped: "orgii:auth_skipped",
  processedCode: "hosted_processed_code",
} as const;

export const HOSTED_LOGIN_ENABLED =
  process.env.REACT_APP_HOSTED_LOGIN_ENABLED === "true";

export function isAuthSkipped(): boolean {
  if (!HOSTED_LOGIN_ENABLED) return true;
  if (typeof window === "undefined") return false;
  return localStorage.getItem(SERVICE_AUTH_STORAGE_KEYS.authSkipped) === "1";
}

export function setAuthSkipped(skipped: boolean): void {
  if (skipped) {
    localStorage.setItem(SERVICE_AUTH_STORAGE_KEYS.authSkipped, "1");
  } else {
    localStorage.removeItem(SERVICE_AUTH_STORAGE_KEYS.authSkipped);
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

export async function markCodeAsProcessed(code: string): Promise<void> {
  localStorage.setItem(
    SERVICE_AUTH_STORAGE_KEYS.processedCode,
    code.substring(0, 20)
  );
}

export async function isCodeAlreadyProcessed(code: string): Promise<boolean> {
  return (
    localStorage.getItem(SERVICE_AUTH_STORAGE_KEYS.processedCode) ===
    code.substring(0, 20)
  );
}

export async function clearProcessedCode(): Promise<void> {
  localStorage.removeItem(SERVICE_AUTH_STORAGE_KEYS.processedCode);
}

export function storeHostedToken(
  accessToken: string,
  expiresIn: number,
  refreshToken?: string
): void {
  const expiryTime = Date.now() + expiresIn * 1000;

  localStorage.setItem(SERVICE_AUTH_STORAGE_KEYS.accessToken, accessToken);
  localStorage.setItem(
    SERVICE_AUTH_STORAGE_KEYS.tokenExpiry,
    expiryTime.toString()
  );

  if (refreshToken) {
    localStorage.setItem(SERVICE_AUTH_STORAGE_KEYS.refreshToken, refreshToken);
  }
}

export function storeHostedUserId(userId: string): void {
  localStorage.setItem(SERVICE_AUTH_STORAGE_KEYS.userId, userId);
  localStorage.setItem("user_id", userId);
}

export function getHostedToken(): string | null {
  const token = localStorage.getItem(SERVICE_AUTH_STORAGE_KEYS.accessToken);
  const expiryStr = localStorage.getItem(SERVICE_AUTH_STORAGE_KEYS.tokenExpiry);

  if (!token || !expiryStr) {
    return null;
  }

  const expiry = parseInt(expiryStr, 10);
  if (Date.now() >= expiry) {
    return null;
  }

  return token;
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(SERVICE_AUTH_STORAGE_KEYS.refreshToken);
}

export function hasRefreshToken(): boolean {
  return !!getRefreshToken();
}

export function clearHostedToken(): void {
  localStorage.removeItem(SERVICE_AUTH_STORAGE_KEYS.accessToken);
  localStorage.removeItem(SERVICE_AUTH_STORAGE_KEYS.refreshToken);
  localStorage.removeItem(SERVICE_AUTH_STORAGE_KEYS.tokenExpiry);
  localStorage.removeItem(SERVICE_AUTH_STORAGE_KEYS.userId);
  localStorage.removeItem(SERVICE_AUTH_STORAGE_KEYS.processedCode);
  localStorage.removeItem("id_token");
  localStorage.removeItem("user_id");
  localStorage.removeItem("orgii-user-info");
}

export function isServiceAuthenticated(): boolean {
  return getHostedToken() !== null || hasRefreshToken();
}

export function getTokenExpiryTime(): number | null {
  const expiryStr = localStorage.getItem(SERVICE_AUTH_STORAGE_KEYS.tokenExpiry);
  if (!expiryStr) return null;
  return parseInt(expiryStr, 10);
}

export function getTimeUntilExpiry(): number | null {
  const expiry = getTokenExpiryTime();
  if (!expiry) return null;
  return Math.max(0, Math.floor((expiry - Date.now()) / 1000));
}

export function isTokenAboutToExpire(thresholdSeconds: number = 300): boolean {
  const timeLeft = getTimeUntilExpiry();
  if (timeLeft === null) return true;
  return timeLeft <= thresholdSeconds;
}

export interface TokenVerifyResponse {
  valid: boolean;
  user_id?: string;
  email?: string;
  name?: string;
  roles?: string[];
}

export async function verifyHostedToken(): Promise<TokenVerifyResponse> {
  const token = getHostedToken();

  if (!token) {
    return { valid: false };
  }

  const response = await invoke<{ status: number; data: unknown }>(
    "hosted_service_proxy",
    {
      request: {
        method: "GET",
        path: "/auth/verify",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    }
  );

  if (response.status < 200 || response.status >= 300) {
    return { valid: false };
  }

  return response.data as TokenVerifyResponse;
}
