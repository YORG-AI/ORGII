/**
 * Hook for polling the per-server stdio log buffer.
 *
 * Wraps the `lsp_get_server_log` Tauri command (backed by the Rust
 * `crates/lsp/src/log_buffer.rs` ring buffer). The drawer in the
 * `LanguageServersPage` Preview panel calls this with `enabled` true
 * only while the drawer is open so we don't poll for every server in
 * the table.
 *
 * Polling — not push — is intentional: the buffer is a small bounded
 * snapshot, the user only watches it when actively diagnosing, and a
 * 1.5 s tick keeps the wire chatter minimal. If we ever need true
 * realtime tailing we can reuse the existing code-editor WebSocket;
 * for now this is the simplest correct path.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useVisiblePolling } from "@src/hooks/async";
import type { LspLogLine } from "@src/modules/MainApp/Integrations/DevTools/LanguageServersPage/types";

const POLL_INTERVAL_MS = 1500;

async function tauriInvoke<T>(
  command: string,
  args: Record<string, unknown>
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export interface UseLspServerLogOptions {
  language: string | null;
  enabled: boolean;
}

export interface UseLspServerLogResult {
  log: LspLogLine[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useLspServerLog({
  language,
  enabled,
}: UseLspServerLogOptions): UseLspServerLogResult {
  const [log, setLog] = useState<LspLogLine[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const fetchOnce = useCallback(
    async (signal?: AbortSignal) => {
      if (!language) {
        setLog([]);
        return;
      }
      setIsLoading(true);
      try {
        const next = await tauriInvoke<LspLogLine[]>("lsp_get_server_log", {
          language,
        });
        if (signal?.aborted || cancelledRef.current) return;
        setLog(next);
        setError(null);
      } catch (err) {
        if (signal?.aborted || cancelledRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!signal?.aborted && !cancelledRef.current) setIsLoading(false);
      }
    },
    [language]
  );

  useEffect(() => {
    cancelledRef.current = false;
    if (!enabled || !language) {
      setLog([]);
    }
    return () => {
      cancelledRef.current = true;
    };
  }, [enabled, language]);

  useVisiblePolling({
    enabled: enabled && !!language,
    intervalMs: POLL_INTERVAL_MS,
    poll: fetchOnce,
  });

  return { log, isLoading, error, refresh: fetchOnce };
}
