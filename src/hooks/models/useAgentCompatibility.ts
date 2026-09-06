/**
 * Agent/provider compatibility helpers — pure functions backed by Rust data.
 *
 * All compatibility decisions read from AgentRegistry (populated from Rust's
 * `get_available_agents` and `get_available_api_providers`). No frontend
 * re-derivation of rules that Rust already defines.
 */
import { useAtomValue } from "jotai";

import type { DispatchCategory } from "@src/api/tauri/session";
import { CLI_AGENT } from "@src/api/types/keys";
import {
  type AgentRegistry,
  agentRegistryAtom,
  agentRegistryDiscoveryStateAtom,
} from "@src/store/session/agentRegistryAtom";

// ============ PURE FUNCTIONS ============

/**
 * All provider types compatible with a CLI agent: the agent itself
 * plus any API key providers it can use (bring-your-own-key).
 *
 * Reads `agent.compatibleApiProviders` directly from Rust data.
 */
export function getCliCompatibleProviderTypes(
  registry: AgentRegistry,
  cliAgentType: string
): Set<string> {
  const types = new Set<string>([cliAgentType]);
  const agent = registry.agents.find((agent) => agent.name === cliAgentType);
  if (agent) {
    for (const provider of agent.compatibleApiProviders) {
      types.add(provider);
    }
  }
  return types;
}

/**
 * Filter accounts to those compatible with a CLI agent.
 * Includes both the agent's own plan accounts AND compatible API key accounts.
 */
export function getCliCompatibleAccounts<
  T extends {
    modelType: string;
    status: string;
    canLaunchCli?: boolean;
    hasApiKey?: boolean;
  },
>(registry: AgentRegistry, cliAgentType: string, accounts: T[]): T[] {
  const compatTypes = getCliCompatibleProviderTypes(registry, cliAgentType);
  return accounts.filter((acc) => {
    if (acc.status !== "ready") return false;

    // Cursor CLI: both the plan account AND the API key account must pass
    // the canLaunchCli gate (Cursor plan account needs canLaunchCli=true,
    // and Cursor API key needs hasApiKey=true).
    if (
      cliAgentType === CLI_AGENT.CURSOR &&
      acc.modelType === CLI_AGENT.CURSOR
    ) {
      return acc.hasApiKey === true && acc.canLaunchCli === true;
    }

    // For the CLI agent's own account type (e.g. "claude_code" key for
    // claude_code sessions), respect the canLaunchCli gate — these are
    // subscription/session-token accounts and canLaunchCli tells us
    // whether the token material is actually present.
    //
    // For compatible API provider accounts (e.g. "anthropic_api" key
    // for claude_code sessions), do NOT apply the canLaunchCli gate.
    // canLaunchCli is false for all API provider model types by design
    // (they are not CLI agent accounts), but they are still valid
    // sources for CLI agents that list them in compatibleApiProviders.
    if (acc.modelType === cliAgentType && acc.canLaunchCli === false) {
      return false;
    }

    return compatTypes.has(acc.modelType);
  });
}

/**
 * Filter accounts to those compatible with Rust-native agents
 * (OS Agent, SDE Agent, custom agents).
 *
 * Checks `supportsRustAgents` on BOTH CLI agents and API providers
 * from the Rust backend definitions.
 */
export function getRustCompatibleAccounts<
  T extends { modelType: string; status: string; hasKey?: boolean },
>(registry: AgentRegistry, accounts: T[]): T[] {
  const rustCompatibleTypes = new Set<string>();

  for (const agent of registry.agents) {
    if (agent.supportsRustAgents) {
      rustCompatibleTypes.add(agent.name);
    }
  }
  for (const provider of registry.apiProviders) {
    if (provider.supportsRustAgents) {
      rustCompatibleTypes.add(provider.name);
    }
  }

  return accounts.filter(
    (acc) =>
      acc.status === "ready" &&
      (acc.hasKey ?? true) &&
      rustCompatibleTypes.has(acc.modelType)
  );
}

/**
 * Check if a source (model type / provider) is compatible with the
 * currently selected agent. Used when switching agents to detect
 * if the current model/source selection is still valid.
 */
export function isSourceCompatibleWithAgent(
  registry: AgentRegistry,
  dispatchCategory: DispatchCategory,
  cliAgentType: string | undefined,
  sourceModelType: string
): boolean {
  if (dispatchCategory === "rust_agent") {
    const agent = registry.agents.find(
      (agent) => agent.name === sourceModelType
    );
    if (agent) return agent.supportsRustAgents;

    const provider = registry.apiProviders.find(
      (provider) => provider.name === sourceModelType
    );
    if (provider) return provider.supportsRustAgents;

    return true;
  }

  if (dispatchCategory === "cli_agent" && cliAgentType) {
    const compatTypes = getCliCompatibleProviderTypes(registry, cliAgentType);
    return compatTypes.has(sourceModelType);
  }

  return true;
}

// ============ HOOK ============

/**
 * Convenience hook — reads the global agent registry and returns it
 * alongside the pure compatibility functions.
 *
 * Usage:
 * ```ts
 * const { registry } = useAgentCompatibility();
 * const compatible = getCliCompatibleAccounts(registry, "claude_code", accounts);
 * ```
 */
export function useAgentCompatibility() {
  const registry = useAtomValue(agentRegistryAtom);
  const discoveryState = useAtomValue(agentRegistryDiscoveryStateAtom);
  return { registry, discoveryState };
}
