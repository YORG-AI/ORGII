import { invoke } from "@tauri-apps/api/core";

import { getAgentConfig, updateAgentConfig } from "@src/api/tauri/agent/config";
import type { AgentToolFilter } from "@src/api/tauri/agent/types";
import { rpc } from "@src/api/tauri/rpc";
import { SETTINGS_REGISTRY } from "@src/config/settingsSchema/registry";

import { asError } from "../result";
import type { Err, Json, Result } from "../types";

export function createConfigHelpers() {
  const getAgentDef = async (
    agentId: string
  ): Promise<Result<{ def: Json }>> => {
    try {
      if (!agentId) {
        return { ok: false, error: "getAgentDef: `agentId` is required" };
      }
      const def = (await rpc.agentDef.get({ agentId })) as Json;
      return { ok: true, def };
    } catch (err) {
      return asError(err);
    }
  };

  const updateAgentDefPatch = async (
    agentId: string,
    patch: Json
  ): Promise<{ ok: true } | Err> => {
    try {
      if (!agentId) {
        return {
          ok: false,
          error: "updateAgentDefPatch: `agentId` is required",
        };
      }
      await rpc.agentDef.updatePatch({ agentId, patch });
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  const addAgentDef = async (
    definition: Json
  ): Promise<Result<{ agentId: string }>> => {
    try {
      if (!definition || typeof definition !== "object") {
        return { ok: false, error: "addAgentDef: `definition` is required" };
      }
      const agentId = (await rpc.agentDef.add({
        agentJson: JSON.stringify(definition),
      })) as string;
      return { ok: true, agentId };
    } catch (err) {
      return asError(err);
    }
  };

  /**
   * Apply a full definition as a patch via `agent_def_update_patch` —
   * the wholesale-replace `agent_definitions_update` RPC was retired.
   * The definition's `id` selects the target; remaining fields become
   * the patch body.
   */
  const updateAgentDef = async (
    definition: Json
  ): Promise<{ ok: true } | Err> => {
    try {
      if (
        !definition ||
        typeof definition !== "object" ||
        Array.isArray(definition)
      ) {
        return { ok: false, error: "updateAgentDef: `definition` is required" };
      }
      const { id, ...patch } = definition as Record<string, unknown>;
      if (typeof id !== "string" || !id) {
        return { ok: false, error: "updateAgentDef: `definition.id` required" };
      }
      await rpc.agentDef.updatePatch({ agentId: id, patch });
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  const resetAgentDefBuiltin = async (
    agentId: string
  ): Promise<Result<{ def: Json }>> => {
    try {
      if (!agentId) {
        return {
          ok: false,
          error: "resetAgentDefBuiltin: `agentId` is required",
        };
      }
      const def = (await rpc.agentDef.resetBuiltin({ agentId })) as Json;
      return { ok: true, def };
    } catch (err) {
      return asError(err);
    }
  };

  const removeAgentDef = async (
    agentId: string
  ): Promise<Result<{ removed: boolean }>> => {
    try {
      if (!agentId) {
        return { ok: false, error: "removeAgentDef: `agentId` is required" };
      }
      const removed = (await rpc.agentDef.remove({ agentId })) as boolean;
      return { ok: true, removed };
    } catch (err) {
      return asError(err);
    }
  };

  const listAgentDefs = async (): Promise<Result<{ defs: Json[] }>> => {
    try {
      const defs = (await rpc.agentDef.listAll()) as unknown as Json[];
      return { ok: true, defs };
    } catch (err) {
      return asError(err);
    }
  };

  const listAllTools = async (): Promise<Result<{ tools: Json[] }>> => {
    try {
      const tools = (await rpc.tools.listAllTools()) as Json[];
      return { ok: true, tools };
    } catch (err) {
      return asError(err);
    }
  };

  const getIntegrations = async (): Promise<Result<{ integrations: Json }>> => {
    try {
      const integrations = (await rpc.integrations.get()) as Json;
      return { ok: true, integrations };
    } catch (err) {
      return asError(err);
    }
  };

  const updateIntegrationsPatch = async (
    patch: Json
  ): Promise<{ ok: true } | Err> => {
    try {
      await rpc.integrations.updatePatch({ patch });
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  const getAgentConfigBlob = async (
    agentType: "os" | "sde"
  ): Promise<Result<{ blob: Json }>> => {
    try {
      const blob = (await getAgentConfig(agentType as AgentToolFilter)) as Json;
      return { ok: true, blob };
    } catch (err) {
      return asError(err);
    }
  };

  const updateAgentConfigBlob = async (
    agentType: "os" | "sde",
    update: Json
  ): Promise<{ ok: true } | Err> => {
    try {
      await updateAgentConfig(agentType as AgentToolFilter, update);
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  const readSettings = async (): Promise<Result<{ settings: Json }>> => {
    try {
      const settings = (await rpc.settings.read()) as Json;
      return { ok: true, settings };
    } catch (err) {
      return asError(err);
    }
  };

  const writeSettingsPartial = async (
    partial: Json
  ): Promise<{ ok: true } | Err> => {
    try {
      await rpc.settings.writePartial({ partial });
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  const getSettingsRegistryKeys = async (): Promise<
    Result<{ keys: string[] }>
  > => {
    try {
      return { ok: true, keys: Object.keys(SETTINGS_REGISTRY) };
    } catch (err) {
      return asError(err);
    }
  };

  const getDesktopConfig = async (): Promise<Result<{ config: Json }>> => {
    try {
      const config = (await invoke("agent_get_desktop_config")) as Json;
      return { ok: true, config };
    } catch (err) {
      return asError(err);
    }
  };

  const setDesktopConfig = async (
    config: Json
  ): Promise<{ ok: true } | Err> => {
    try {
      await invoke("agent_set_desktop_config", { config });
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  return {
    getAgentDef,
    updateAgentDefPatch,
    addAgentDef,
    updateAgentDef,
    resetAgentDefBuiltin,
    removeAgentDef,
    listAgentDefs,
    listAllTools,
    getIntegrations,
    updateIntegrationsPatch,
    getAgentConfigBlob,
    updateAgentConfigBlob,
    readSettings,
    writeSettingsPartial,
    getSettingsRegistryKeys,
    getDesktopConfig,
    setDesktopConfig,
  };
}
