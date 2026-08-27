/**
 * useOSAgentConfig Hook
 *
 * Manages OS Agent configuration: loading, saving (debounced),
 * and credential checking.
 *
 * Load / debounced-save / undo wiring is provided by useAgentConfigBase.
 * This hook adds OS-specific credential checking.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  checkKeys,
  getAgentConfig,
  updateAgentConfig,
} from "@src/api/tauri/agent";
import { RUST_AGENT_TYPE } from "@src/api/tauri/agent/types";
import { createLogger } from "@src/hooks/logger";

import type { CredentialStatus } from "./types";
import { useAgentConfigBase } from "./useAgentConfigBase";
import { getNestedString, setNested } from "./utils";

const log = createLogger("OSAgent");

export interface UseOSAgentConfigReturn {
  config: Record<string, unknown>;
  loaded: boolean;
  credStatus: CredentialStatus | null;
  update: (path: string, value: unknown) => void;
  /** Replace the entire config object (for operations like deleteNested) */
  rawUpdate: (newConfig: Record<string, unknown>) => void;
}

export function useOSAgentConfig(): UseOSAgentConfigReturn {
  const [credStatus, setCredStatus] = useState<CredentialStatus | null>(null);
  const credCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const credCheckGenerationRef = useRef(0);

  const debouncedCheckCredentials = useCallback((model: string) => {
    const generation = ++credCheckGenerationRef.current;
    if (credCheckTimerRef.current) clearTimeout(credCheckTimerRef.current);
    credCheckTimerRef.current = setTimeout(() => {
      if (!model) {
        if (credCheckGenerationRef.current === generation) {
          setCredStatus(null);
        }
        return;
      }
      checkKeys(model)
        .then((status) => {
          if (credCheckGenerationRef.current === generation) {
            setCredStatus(status as unknown as CredentialStatus);
          }
        })
        .catch((err) => {
          if (credCheckGenerationRef.current !== generation) return;
          log.warn("[OSAgent] credential check failed:", err);
          setCredStatus(null);
        });
    }, 300);
  }, []);

  // Cleanup cred-check timer on unmount
  useEffect(() => {
    return () => {
      credCheckGenerationRef.current += 1;
      if (credCheckTimerRef.current) clearTimeout(credCheckTimerRef.current);
    };
  }, []);

  const loadConfig = useCallback(
    () =>
      getAgentConfig(RUST_AGENT_TYPE.OS).then(
        (parsed) => parsed as unknown as Record<string, unknown>
      ),
    []
  );
  const persistConfig = useCallback(
    (newConfig: Record<string, unknown>) =>
      updateAgentConfig(RUST_AGENT_TYPE.OS, newConfig),
    []
  );

  const { config, loaded, saveConfig, updateWithUndo } = useAgentConfigBase({
    load: loadConfig,
    save: persistConfig,
  });

  // Credential status synchronizes with the current model, regardless of
  // whether it came from initial load, a direct edit, or undo restoration.
  const currentModel = loaded ? getNestedString(config, "model", "") : null;
  useEffect(() => {
    if (currentModel === null) return;
    debouncedCheckCredentials(currentModel);
  }, [currentModel, debouncedCheckCredentials]);

  const update = useCallback(
    (path: string, value: unknown) => {
      updateWithUndo(setNested(config, path, value));
    },
    [config, updateWithUndo]
  );

  return { config, loaded, credStatus, update, rawUpdate: saveConfig };
}
