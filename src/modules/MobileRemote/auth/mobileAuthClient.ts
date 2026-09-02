import type { MobileAuthSession } from "./mobileAuthState";

export class MobileAuthClientError extends Error {
  constructor(
    message: string,
    readonly retryable = true
  ) {
    super(message);
    this.name = "MobileAuthClientError";
  }
}

/** Platform-neutral account authentication contract used by the shared UI. */
export interface MobileAuthClient {
  buildLoginUrl(callbackUrl: string): Promise<string>;
  exchangeCallback(callbackUrl: string): Promise<MobileAuthSession>;
  restoreSession(
    stored: MobileAuthSession,
    options?: { forceRefresh?: boolean }
  ): Promise<MobileAuthSession>;
  establishServerSession(accessToken: string): Promise<void>;
  signOut(session: MobileAuthSession | null): Promise<void>;
}

export function isRetryableMobileAuthError(error: unknown): boolean {
  return !(error instanceof MobileAuthClientError) || error.retryable;
}
