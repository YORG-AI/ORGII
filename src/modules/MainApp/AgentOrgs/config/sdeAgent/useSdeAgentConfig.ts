/**
 * useSdeAgentConfig Hook
 *
 * Manages SDE Agent configuration: loading and saving (debounced).
 * Config is loaded from `.orgii/coding-agent.json` via Tauri commands.
 *
 * Load / debounced-save / undo wiring is provided by useAgentConfigBase.
 */
import { useCallback } from "react";

import { getAgentConfig, updateAgentConfig } from "@src/api/tauri/agent";
import { RUST_AGENT_TYPE } from "@src/api/tauri/agent/types";

import { useAgentConfigBase } from "../osAgent/useAgentConfigBase";
import { setNested } from "../osAgent/utils";

export interface UseSdeAgentConfigReturn {
  config: Record<string, unknown>;
  loaded: boolean;
  update: (key: string, value: unknown) => void;
}

export function useSdeAgentConfig(
  workspacePath?: string
): UseSdeAgentConfigReturn {
  const load = useCallback(
    () =>
      getAgentConfig(
        RUST_AGENT_TYPE.SDE,
        workspacePath ?? ""
      ) as unknown as Promise<Record<string, unknown>>,
    [workspacePath]
  );

  const save = useCallback(
    (newConfig: Record<string, unknown>) =>
      updateAgentConfig(RUST_AGENT_TYPE.SDE, newConfig, workspacePath ?? ""),
    [workspacePath]
  );

  const { config, loaded, updateWithUndo } = useAgentConfigBase({
    load,
    save,
  });

  // Update a single key (supports dotted paths like "security.autonomy")
  // and save. Uses setNested so dot paths produce nested objects rather
  // than literal "security.autonomy" top-level keys.
  const update = useCallback(
    (key: string, value: unknown) => {
      const newConfig = key.includes(".")
        ? setNested(config, key, value)
        : { ...config, [key]: value };
      updateWithUndo(newConfig);
    },
    [config, updateWithUndo]
  );

  return { config, loaded, update };
}
