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
import { useCallback } from "react";

import { useVisibilityPolledData } from "@src/hooks/async";
import type { LspLogLine } from "@src/modules/MainApp/Integrations/DevTools/LanguageServersPage/types";

const POLL_INTERVAL_MS = 1500;
const EMPTY_LOG: LspLogLine[] = [];

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
  const fetchLog = useCallback(
    (scope: string) =>
      tauriInvoke<LspLogLine[]>("lsp_get_server_log", { language: scope }),
    []
  );
  const { data, loading, error, refresh } = useVisibilityPolledData({
    enabled: enabled && Boolean(language),
    fetcher: fetchLog,
    initialData: EMPTY_LOG,
    intervalMs: POLL_INTERVAL_MS,
    scopeKey: language,
  });

  return { log: data, isLoading: loading, error, refresh };
}
