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
