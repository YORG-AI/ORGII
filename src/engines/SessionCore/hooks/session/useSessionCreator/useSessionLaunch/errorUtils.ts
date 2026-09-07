/**
 * Error classification utilities for session launch
 */

export function isAuthError(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  return (
    lowerMessage.includes("unauthorized") ||
    lowerMessage.includes("invalid api key") ||
    lowerMessage.includes("invalid_api_key") ||
    lowerMessage.includes("authentication failed") ||
    lowerMessage.includes("authorization header required") ||
    /\b401\b/.test(lowerMessage)
  );
}

export const RUN_QUEUED_ERROR_PREFIX = "PM_RUN_ERR:RUN_QUEUED";

export function isRunQueuedBehindCheckout(message: string): boolean {
  return message.includes(RUN_QUEUED_ERROR_PREFIX);
}

export function isBalanceError(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  return (
    lowerMessage.includes("insufficient funds") ||
    lowerMessage.includes("insufficient balance") ||
    lowerMessage.includes("minimum balance") ||
    lowerMessage.includes("payment required") ||
    /\b402\b/.test(lowerMessage)
  );
}

/**
 * Maps raw Rust error messages to user-friendly hints.
 */
const ERROR_PATTERNS: Array<{
  test: (msg: string) => boolean;
  hint: string;
}> = [
  {
    test: (msg) => /not found in key vault/i.test(msg),
    hint: "The selected account was not found. Please go to Settings → Keys and select a valid account.",
  },
  {
    test: (msg) => /no account selected/i.test(msg),
    hint: "No account selected. Please select a Code Account in the model selector before starting a session.",
  },
  {
    test: (msg) => /not compatible with provider/i.test(msg),
    hint: "The selected account is not compatible with this provider. Please choose an account that matches the provider type.",
  },
  {
    test: (msg) => /no api key or session token/i.test(msg),
    hint: "The selected account has no API key configured. Please update it in Settings → Keys.",
  },
  {
    test: (msg) => /session not found/i.test(msg),
    hint: "Session creation failed — the backend could not initialize the session. Please try again.",
  },
  {
    test: (msg) => /token expired|token invalid/i.test(msg),
    hint: "Your session token has expired. Please re-authenticate in Settings → Keys.",
  },
];

export function formatAgentLaunchError(rawMessage: string): string {
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(rawMessage)) {
      return pattern.hint;
    }
  }
  return `Agent error: ${rawMessage}`;
}
