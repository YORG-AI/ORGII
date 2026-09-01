import { CLI_AGENT } from "@src/api/tauri/rpc/schemas/validation";

export type AgentCategory =
  | "cursor"
  | "codex"
  | "copilot"
  | "kiro"
  | "claude_code"
  | "api_key_provider"
  | "generic";

interface ApiSetupAgentFlags {
  agentCategory: AgentCategory;
  isCursor: boolean;
  isCodex: boolean;
  isCopilot: boolean;
  isKiro: boolean;
  isClaudeCode: boolean;
  isApiProvider: boolean;
  isOAuthAgent: boolean;
}

const getAgentCategory = (agentType: string): AgentCategory => {
  if (agentType === CLI_AGENT.CURSOR) return "cursor";
  if (agentType === CLI_AGENT.CODEX) return "codex";
  if (agentType === CLI_AGENT.COPILOT) return "copilot";
  if (agentType === CLI_AGENT.KIRO) return "kiro";
  if (agentType === CLI_AGENT.CLAUDE_CODE) return "claude_code";
  if (agentType.endsWith("_api")) return "api_key_provider";
  return "generic";
};

export function getApiSetupAgentFlags(agentType: string): ApiSetupAgentFlags {
  const agentCategory = getAgentCategory(agentType);
  const isCursor = agentCategory === "cursor";
  const isCodex = agentCategory === "codex";
  const isCopilot = agentCategory === "copilot";
  const isKiro = agentCategory === "kiro";
  const isClaudeCode = agentCategory === "claude_code";
  const isApiProvider = agentCategory === "api_key_provider";
  const isOAuthAgent = isKiro || isClaudeCode || isCodex;

  return {
    agentCategory,
    isCursor,
    isCodex,
    isCopilot,
    isKiro,
    isClaudeCode,
    isApiProvider,
    isOAuthAgent,
  };
}
