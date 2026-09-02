import type { MobileAuthClient } from "../auth/mobileAuthClient";
import type { MobileAuthSession } from "../auth/mobileAuthState";
import type {
  MobileConnectionConfig,
  MobilePairedDesktopSummary,
} from "../connection/types";

export type MobileRemoteIntentEvent = "auth_callback" | "pairing";

export interface MobileRemoteRuntimePort {
  now(): number;
  random(): number;
  randomUUID(): string;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(timeoutId: number): void;
  isHidden(): boolean;
  subscribeVisibility(listener: () => void): () => void;
}

export interface MobileRemoteAuthPort {
  createClient(): MobileAuthClient;
  captureInitialPairingIntent(): string | null;
  isCallback(): boolean;
  currentUrl(): string;
  callbackUrl(): string;
  scrubCallback(): void;
  navigate(url: string): void | Promise<void>;
  beginOAuthAttempt(attemptId: string): Promise<void>;
  consumeOAuthAttempt(): Promise<boolean>;
  consumePairingIntent(): Promise<string | null>;
  clearIntents(): Promise<void>;
  readSession(): Promise<MobileAuthSession | null>;
  writeSession(session: MobileAuthSession): Promise<void>;
  clearSession(): Promise<void>;
  /** Native shells notify warm OAuth callbacks and pairing deep links here. */
  subscribeIntent(
    listener: (event: MobileRemoteIntentEvent) => void
  ): () => void;
}

export interface MobileRemoteConnectionPort {
  createSocket(url: string): WebSocket;
  load(userId: string): Promise<MobileConnectionConfig | null>;
  listPairedDesktops(userId: string): Promise<MobilePairedDesktopSummary[]>;
  selectPairedDesktop(
    userId: string,
    desktopId: string
  ): Promise<MobileConnectionConfig | null>;
  /** Implementations must serialize writes so the latest invocation wins. */
  save(userId: string, config: MobileConnectionConfig | null): Promise<void>;
}

/**
 * The shared Remote application depends on this port rather than browser or
 * Tauri globals. Platform shells own credentials, navigation and lifecycle.
 */
export interface MobileRemotePlatform {
  readonly kind: "browser" | "ios";
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
    readonly defaultDeviceLabel: string;
  };
  readonly runtime: MobileRemoteRuntimePort;
  readonly auth: MobileRemoteAuthPort;
  readonly connection: MobileRemoteConnectionPort;
}
