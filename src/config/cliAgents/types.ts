/**
 * CLI Agent Types
 *
 * Re-exports canonical types from validation.ts (single source of truth).
 * DO NOT define duplicate interfaces here.
 */
export type {
  AvailableAgent,
  CliInstallMethod,
} from "@src/api/tauri/rpc/schemas/validation";

export type AgentAction = "installing" | "detecting" | null;
