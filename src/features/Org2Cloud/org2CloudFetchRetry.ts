/**
 * One-shot transport-level fetch retry for the org2 cloud raw-fetch clients.
 *
 * On macOS the Tauri webview (WKWebView) pools keep-alive connections; when
 * the server silently closes an idle pooled socket, CFNetwork surfaces the
 * next request as `TypeError: Load failed` WITHOUT retrying it — the system
 * auto-retries idempotent GETs on a fresh connection but never POSTs, and
 * every Supabase RPC here is a POST. That failure happens before the request
 * is delivered and evicts the dead socket, so one immediate retry on a fresh
 * connection is safe and deterministic (the classic "first click after idle
 * fails, the second succeeds").
 *
 * `fetch()` rejects with TypeError only for network-class failures (dead
 * socket, DNS, CORS); AbortError/TimeoutError are DOMExceptions and are
 * never retried. Callers must pass a re-sendable body (a string — true for
 * every JSON RPC client here), not a one-shot stream.
 */

export async function fetchWithTransportRetry(
  input: string | URL,
  init?: RequestInit
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (!isFetchTransportError(error) || init?.signal?.aborted) throw error;
    return fetch(input, init);
  }
}

/**
 * Bound a complete cloud operation even on WKWebView versions where aborting
 * a pending fetch/body read does not reliably settle its Promise. The local
 * race is the authoritative deadline; abort remains best-effort cleanup.
 */
export async function runCloudRequestWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  sourceSignal?: AbortSignal | null
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onSourceAbort: (() => void) | undefined;

  const deadline = new Promise<T>((_resolve, reject) => {
    const rejectAborted = () => {
      controller.abort();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    if (sourceSignal?.aborted) {
      rejectAborted();
      return;
    }
    if (sourceSignal) {
      onSourceAbort = rejectAborted;
      sourceSignal.addEventListener("abort", rejectAborted, { once: true });
    }
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(
        new DOMException(
          `Cloud request timed out after ${timeoutMs}ms.`,
          "TimeoutError"
        )
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (sourceSignal && onSourceAbort) {
      sourceSignal.removeEventListener("abort", onSourceAbort);
    }
  }
}

/** Fetch-only convenience wrapper. Prefer `runCloudRequestWithTimeout` when
 * response body decoding/parsing must share the same deadline. */
export async function fetchWithTransportRetryAndTimeout(
  input: string | URL,
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<Response> {
  return runCloudRequestWithTimeout(
    (timeoutSignal) =>
      fetchWithTransportRetry(input, {
        ...init,
        signal: timeoutSignal,
      }),
    timeoutMs,
    init?.signal
  );
}

/**
 * Known webview fetch transport-failure messages (WebKit / Chromium /
 * Firefox). Same set as `normalizeGitActionDialogMessage`; kept message-based
 * so a random programming TypeError is never mislabeled as a network issue.
 */
const TRANSPORT_ERROR_MESSAGES: ReadonlySet<string> = new Set([
  "load failed",
  "failed to fetch",
  "networkerror when attempting to fetch resource.",
]);

/** True when `error` is a fetch network failure (vs an HTTP/server error). */
export function isFetchTransportError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    TRANSPORT_ERROR_MESSAGES.has(error.message.trim().toLowerCase())
  );
}
