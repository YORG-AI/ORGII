import type { CliAgentType } from "@src/api/tauri/rpc/schemas/validation";

/**
 * A contextual allowlist gates execution capability, not discovery. New
 * Session passes no allowlist; continuation surfaces pass their lossless
 * native-writer targets and keep every other installed runtime visible.
 */
export function cliAgentCapabilityDisabled(
  agentType: CliAgentType,
  allowedCliAgentTypes?: readonly CliAgentType[]
): boolean {
  return Boolean(
    allowedCliAgentTypes && !allowedCliAgentTypes.includes(agentType)
  );
}
