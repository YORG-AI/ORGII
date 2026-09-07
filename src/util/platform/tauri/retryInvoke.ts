/**
 * Retry wrapper for Tauri IPC invocations.
 *
 * Retries on transient errors (rate-limit, network) with exponential backoff.
 * After all retries are exhausted, appends an error event to the chat timeline
 * so the user sees the failure inline instead of only as a toast.
 */
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { makeErrorEvent } from "@src/engines/SessionCore/sync/adapters/shared/eventFactories";
import { createLogger } from "@src/hooks/logger";

import { invokeTauri } from "./init";

const log = createLogger("retryInvoke");

const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [2_000, 5_000];

const RATE_LIMIT_PATTERNS = [
  "429",
  "rate limit",
  "rate_limit",
  "too many requests",
];

function isRateLimitError(message: string): boolean {
  const lower = message.toLowerCase();
  return RATE_LIMIT_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Invoke a Tauri command with automatic retry for rate-limit / transient errors.
 *
 * On final failure, appends an error event to the chat timeline for the given
 * sessionId so the error is visible inline.
 */
export async function retryInvokeTauri<T = unknown>(
  cmd: string,
  args: Record<string, unknown>,
  sessionId: string
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await invokeTauri<T>(cmd, args);
    } catch (err: unknown) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);

      if (!isRateLimitError(message) || attempt === MAX_RETRIES) {
        break;
      }

      const delay =
        RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
      log.warn(
        `[retryInvoke] ${cmd} attempt ${attempt + 1}/${MAX_RETRIES + 1} failed (rate limit), retrying in ${delay}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  const errorMsg =
    lastError instanceof Error ? lastError.message : String(lastError);

  const errorEvent = makeErrorEvent(sessionId, errorMsg);
  eventStoreProxy.append([errorEvent]);

  // Keep the originating user prompt visible on final failure so the user
  // can see what failed and click "Resume". The Rust backend filters orphan
  // `tool_use` entries on the next
  // send with `isResume: true`, so no duplicate bubbles are produced.

  throw lastError;
}
