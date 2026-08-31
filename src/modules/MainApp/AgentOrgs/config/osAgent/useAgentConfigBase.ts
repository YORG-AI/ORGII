/**
 * useAgentConfigBase — shared load / debounced-save / undo foundation.
 *
 * Encapsulates the pattern that is identical between useOSAgentConfig and
 * useSdeAgentConfig:
 *   1. Load config via a caller-supplied async getter on mount.
 *   2. Expose `saveConfig` — sets local state immediately and schedules a
 *      500 ms debounced write via a caller-supplied async saver.
 *   3. Register a single cleanup effect that cancels any pending timer.
 *   4. Wire up `useUndoStackWithRestore` so Cmd-Z / Ctrl-Z reverts.
 *
 * Callers (useOSAgentConfig, useSdeAgentConfig) provide callbacks whose
 * identities encode the configuration scope. A changed `load` callback
 * reloads that scope; unrelated renders keep the callback stable.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import Message from "@src/components/Message";
import { createLogger } from "@src/hooks/logger";
import { useUndoStackWithRestore } from "@src/hooks/ui";

const log = createLogger("useAgentConfigBase");

export interface UseAgentConfigBaseOptions {
  /** Async fn that returns the initial config record. */
  load: () => Promise<Record<string, unknown>>;
  /** Async fn that persists an updated config record. */
  save: (config: Record<string, unknown>) => Promise<void>;
}

export interface UseAgentConfigBaseReturn {
  config: Record<string, unknown>;
  loaded: boolean;
  /**
   * Write `newConfig` to local state immediately and schedule a debounced
   * persist (500 ms). Replaces the entire config object, so callers should
   * derive `newConfig` from the previous value via `setNested` / spread.
   */
  saveConfig: (newConfig: Record<string, unknown>) => void;
  /**
   * Snapshot the current config, apply `newConfig`, and save. Provided as
   * a convenience so callers that need undo can call this directly instead
   * of pairing `undoStack.snapshot` + `saveConfig` manually.
   */
  updateWithUndo: (newConfig: Record<string, unknown>) => void;
}

const DEBOUNCE_MS = 500;

export function useAgentConfigBase(
  options: UseAgentConfigBaseOptions
): UseAgentConfigBaseReturn {
  const { load, save } = options;

  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [loaded, setLoaded] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load on mount and whenever the caller changes configuration scope.
  useEffect(() => {
    let cancelled = false;

    load()
      .then((parsed) => {
        if (cancelled) return;
        setConfig(parsed);
        setLoaded(true);
      })
      .catch((err) => {
        log.warn("[useAgentConfigBase] load failed:", err);
        if (!cancelled) setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [load]);

  // Cleanup pending timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const saveConfig = useCallback(
    (newConfig: Record<string, unknown>) => {
      setConfig(newConfig);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        save(newConfig).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          Message.error({ content: msg });
        });
      }, DEBOUNCE_MS);
    },
    [save]
  );

  const undoStack = useUndoStackWithRestore<Record<string, unknown>>({
    keyboardShortcut: true,
    currentValue: config,
    onRestore: (prev) => {
      saveConfig(prev);
    },
  });

  const updateWithUndo = useCallback(
    (newConfig: Record<string, unknown>) => {
      undoStack.snapshot(config);
      saveConfig(newConfig);
    },
    [undoStack, config, saveConfig]
  );

  return { config, loaded, saveConfig, updateWithUndo };
}
