/**
 * Hosted service authentication configuration.
 *
 * Supabase Auth owns OAuth PKCE, session persistence, refresh, and sign-out.
 * This file keeps the app-level hosted-service token cache that existing
 * API clients and guards consume.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";

import {
  SHARED_SERVICE_AUTH_STORAGE_KEYS,
  SUPABASE_AUTH_STORAGE_KEY,
  SUPABASE_PKCE_STORAGE_KEY,
  mirrorSharedServiceAuthValue,
} from "@src/api/http/auth/sharedAuthStorage";

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

export const SERVICE_AUTH_STORAGE_KEYS = SHARED_SERVICE_AUTH_STORAGE_KEYS;

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
    mirrorSharedServiceAuthValue(SERVICE_AUTH_STORAGE_KEYS.authSkipped, "1");
  } else {
    localStorage.removeItem(SERVICE_AUTH_STORAGE_KEYS.authSkipped);
    mirrorSharedServiceAuthValue(SERVICE_AUTH_STORAGE_KEYS.authSkipped, null);
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
  const processedCode = code.substring(0, 20);
  localStorage.setItem(SERVICE_AUTH_STORAGE_KEYS.processedCode, processedCode);
  mirrorSharedServiceAuthValue(
    SERVICE_AUTH_STORAGE_KEYS.processedCode,
    processedCode
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
  mirrorSharedServiceAuthValue(SERVICE_AUTH_STORAGE_KEYS.processedCode, null);
}

export function storeHostedToken(
  accessToken: string,
  expiresIn: number,
  refreshToken?: string
): void {
  const expiryTime = Date.now() + expiresIn * 1000;

  localStorage.setItem(SERVICE_AUTH_STORAGE_KEYS.accessToken, accessToken);
  mirrorSharedServiceAuthValue(
    SERVICE_AUTH_STORAGE_KEYS.accessToken,
    accessToken
  );
  localStorage.setItem(
    SERVICE_AUTH_STORAGE_KEYS.tokenExpiry,
    expiryTime.toString()
  );
  mirrorSharedServiceAuthValue(
    SERVICE_AUTH_STORAGE_KEYS.tokenExpiry,
    expiryTime.toString()
  );

  if (refreshToken) {
    localStorage.setItem(SERVICE_AUTH_STORAGE_KEYS.refreshToken, refreshToken);
    mirrorSharedServiceAuthValue(
      SERVICE_AUTH_STORAGE_KEYS.refreshToken,
      refreshToken
    );
  }
}

export function storeHostedUserId(userId: string): void {
  localStorage.setItem(SERVICE_AUTH_STORAGE_KEYS.userId, userId);
  localStorage.setItem("user_id", userId);
  mirrorSharedServiceAuthValue(SERVICE_AUTH_STORAGE_KEYS.userId, userId);
  mirrorSharedServiceAuthValue("user_id", userId);
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
  const keysToClear = [
    SERVICE_AUTH_STORAGE_KEYS.accessToken,
    SERVICE_AUTH_STORAGE_KEYS.refreshToken,
    SERVICE_AUTH_STORAGE_KEYS.tokenExpiry,
    SERVICE_AUTH_STORAGE_KEYS.userId,
    SERVICE_AUTH_STORAGE_KEYS.processedCode,
    SUPABASE_AUTH_STORAGE_KEY,
    SUPABASE_PKCE_STORAGE_KEY,
    "id_token",
    "user_id",
    "orgii-user-info",
  ] as const;

  for (const key of keysToClear) {
    localStorage.removeItem(key);
    mirrorSharedServiceAuthValue(key, null);
  }
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
