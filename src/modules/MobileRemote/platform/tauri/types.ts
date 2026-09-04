import type { MobileRemoteRuntimePort } from "../types";

export type TauriMobileRemoteErrorCode =
  | "oauth_cancelled"
  | "invalid_callback"
  | "invalid_session"
  | "unauthorized"
  | "network"
  | "keychain_locked"
  | "bridge_unavailable";

export interface TauriMobileRemoteNativeError {
  code: TauriMobileRemoteErrorCode | string;
  message?: string;
}

/**
 * Minimal native boundary. OAuth stays in the shared Supabase PKCE client;
 * native code owns only secure storage, deep-link delivery and browser handoff.
 */
export interface TauriMobileRemoteBridge {
  openExternal(url: string): Promise<void>;
  secureRead(key: string): Promise<string | null>;
  secureWrite(key: string, value: string): Promise<void>;
  secureDelete(key: string): Promise<void>;
  getInitialDeepLinks(): Promise<string[]>;
  subscribeDeepLinks(listener: (urls: string[]) => void): Promise<() => void>;
}

export interface TauriMobileRemotePlatformOptions {
  bridge: TauriMobileRemoteBridge;
  runtime: MobileRemoteRuntimePort;
  createSocket(url: string): WebSocket;
  fetcher?: typeof fetch;
  callbackUrl?: string;
  homeUrl?: string;
  clientInfo?: {
    name: string;
    version: string;
    defaultDeviceLabel: string;
  };
}

export interface TauriMobileRemoteController {
  /** Accept an OAuth callback or opaque pairing deep link from the shell. */
  acceptDeepLink(url: string): boolean;
  dispose(): void;
}
