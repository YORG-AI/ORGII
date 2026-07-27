/**
 * Extract error message from any error type.
 * Tauri commands throw plain strings, not Error objects,
 * so we need to handle both cases.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.toLowerCase();
  }
  if (typeof error === "string") {
    return error.toLowerCase();
  }
  return String(error).toLowerCase();
}

/**
 * Check if an error is a network/transient error (should retry)
 * vs an auth error (should logout).
 */
export function isNetworkError(error: unknown): boolean {
  const message = getErrorMessage(error);
  if (
    message.includes("network") ||
    message.includes("fetch") ||
    message.includes("timeout") ||
    message.includes("aborted") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("enotfound") ||
    message.includes("failed to fetch") ||
    message.includes("load failed")
  ) {
    return true;
  }
  if (error instanceof TypeError) {
    return true;
  }
  return false;
}

/**
 * Check if an error indicates the refresh token is invalid (should logout).
 *
 * IMPORTANT: Only match errors that confirm the server rejected the token.
 * Do NOT match storage errors like "No refresh token stored" from keychain —
 * those indicate a localStorage/keychain sync issue, not a server-side rejection.
 */
export function isAuthError(error: unknown): boolean {
  const message = getErrorMessage(error);
  if (
    message.includes("invalid_grant") ||
    message.includes("unauthorized") ||
    message.includes("invalid token") ||
    message.includes("token expired") ||
    message.includes("token revoked")
  ) {
    return true;
  }
  return false;
}

/**
 * Check if error indicates no refresh token exists (user not logged in).
 */
export function isNoRefreshTokenError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return message.includes("no refresh token");
  }
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
