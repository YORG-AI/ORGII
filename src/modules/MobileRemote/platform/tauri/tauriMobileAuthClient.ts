import type { SupportedStorage } from "@supabase/supabase-js";

import {
  type MobileAuthClient,
  MobileAuthClientError,
} from "../../auth/mobileAuthClient";
import { createSupabaseMobileAuthClient } from "../supabaseMobileAuthClient";
import type {
  TauriMobileRemoteBridge,
  TauriMobileRemoteNativeError,
} from "./types";

const OAUTH_STORAGE_PREFIX = "org2.remote.auth.pkce.v1:";
const PERMANENT_NATIVE_CODES = new Set([
  "oauth_cancelled",
  "invalid_callback",
  "invalid_session",
  "unauthorized",
]);

export function toTauriMobileAuthError(error: unknown): MobileAuthClientError {
  if (error instanceof MobileAuthClientError) return error;
  if (error && typeof error === "object") {
    const native = error as Partial<TauriMobileRemoteNativeError>;
    const code = typeof native.code === "string" ? native.code : "";
    const message =
      typeof native.message === "string" && native.message.trim()
        ? native.message
        : code
          ? `Native authentication failed (${code})`
          : "Native authentication failed";
    return new MobileAuthClientError(
      message,
      !PERMANENT_NATIVE_CODES.has(code)
    );
  }
  return new MobileAuthClientError(
    error instanceof Error ? error.message : "Native authentication failed"
  );
}

function oauthKey(key: string): string {
  return `${OAUTH_STORAGE_PREFIX}${encodeURIComponent(key)}`;
}

export function createTauriOAuthStorage(
  bridge: TauriMobileRemoteBridge
): SupportedStorage {
  return {
    async getItem(key) {
      try {
        return await bridge.secureRead(oauthKey(key));
      } catch (error) {
        throw toTauriMobileAuthError(error);
      }
    },
    async setItem(key, value) {
      try {
        await bridge.secureWrite(oauthKey(key), value);
      } catch (error) {
        throw toTauriMobileAuthError(error);
      }
    },
    async removeItem(key) {
      try {
        await bridge.secureDelete(oauthKey(key));
      } catch (error) {
        throw toTauriMobileAuthError(error);
      }
    },
  };
}

export function createTauriMobileAuthClient(options: {
  bridge: TauriMobileRemoteBridge;
  fetcher: typeof fetch;
}): MobileAuthClient {
  return createSupabaseMobileAuthClient({
    oauthStorage: createTauriOAuthStorage(options.bridge),
    fetcher: options.fetcher,
    // A Tauri webview does not own the Relay's browser cookie jar. Native
    // auth is the Supabase session plus the paired Desktop device credential.
    serverSessionUrl: null,
  });
}

export const TAURI_MOBILE_OAUTH_STORAGE_PREFIX = OAUTH_STORAGE_PREFIX;
