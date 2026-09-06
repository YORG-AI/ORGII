/**
 * Global registry for CLI agent and API provider metadata from the Rust backend.
 *
 * Single source of truth for agent/provider compatibility data.
 * Populated by DispatchCategoryPalette and useProviderRegistry.
 * Consumed by useAgentCompatibility() and its pure helper functions.
 */
import { atom } from "jotai";

import type {
  AvailableAgent,
  AvailableApiProvider,
} from "@src/api/tauri/rpc/schemas/validation";

export interface AgentRegistry {
  agents: AvailableAgent[];
  apiProviders: AvailableApiProvider[];
}

/** Initial agent discovery state. A loaded empty registry is distinct from boot. */
type AgentRegistryDiscoveryState = "idle" | "loading" | "ready" | "error";

export const agentRegistryAtom = atom<AgentRegistry>({
  agents: [],
  apiProviders: [],
});

export const agentRegistryDiscoveryStateAtom =
  atom<AgentRegistryDiscoveryState>("idle");
