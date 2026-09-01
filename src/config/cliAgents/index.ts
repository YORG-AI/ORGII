import {
  CLI_AGENT,
  type CliAgentType,
} from "@src/api/tauri/rpc/schemas/validation";

export type {
  AgentAction,
  AgentEnvConfig,
  AvailableAgent,
  CliInstallMethod,
} from "./types";
export type { CliInstallMethod as InstallMethod } from "./types";

/**
 * CLI agents whose managed GUI runs speak the Agent Client Protocol
 * (bidirectional JSON-RPC over stdio). Mirrors `ModelType::is_acp()` in
 * `src-tauri/crates/key-vault/src/key_store/types.rs` and the ACP branch in
 * `src-tauri/src/agent_sessions/cli/session_runner/session.rs`. Every other
 * CLI agent runs as a headless shell-out (one piped subprocess per turn,
 * stream-json/stdout parsing).
 *
 * Note: distinct from the registry's `acpSupport` capability metadata — that
 * describes what the CLI itself supports; this set reflects the transport
 * ORGII's GUI actually uses today.
 */
const ACP_CLI_AGENTS: ReadonlySet<CliAgentType> = new Set<CliAgentType>([
  CLI_AGENT.OPENCODE,
  CLI_AGENT.COPILOT,
  CLI_AGENT.KIRO,
]);

/** Short execution-transport label shown next to CLI agent names in agent pickers. */
export function getCliTransportLabel(
  agentType: CliAgentType
): "ACP" | "shell-out" {
  return ACP_CLI_AGENTS.has(agentType) ? "ACP" : "shell-out";
}

/** Human-readable labels for install method IDs returned by the Rust backend. */
export const METHOD_DISPLAY_LABELS: Record<string, string> = {
  homebrew: "Homebrew",
  npm: "npm",
  pip: "pip / pipx",
  cargo: "Cargo",
  curl: "curl",
  snap: "Snap",
  native: "Native",
  scoop: "Scoop",
};
