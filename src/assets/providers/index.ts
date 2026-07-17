// ============================================
// Agent Type Configuration
// ============================================
import { CLI_AGENT } from "@src/api/tauri/rpc/schemas/validation";

import type { ApiProviderType, CliAgentType } from "./types";

// Re-export model types from types to maintain API
export type { CliAgentType, ApiProviderType, ModelType } from "./types";
export { ORGII_ORCHESTRATOR } from "./types";

/**
 * Format an agent type string into a human-readable display name.
 * Converts snake_case to Title Case and strips common suffixes.
 * Prefer backend-provided `displayName` when available; use this as a fallback.
 */
export function formatAgentType(agentType: string): string {
  if (!agentType) return "";
  return agentType
    .replace(/_api$/, "")
    .replace(/_cli$/, " CLI")
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const MODEL_AGENT_TYPE_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  [CLI_AGENT.CURSOR]: "Cursor",
};

/** Agent type label for model catalog / model table surfaces. */
export function formatModelAgentType(agentType: string): string {
  const override = MODEL_AGENT_TYPE_LABEL_OVERRIDES[agentType];
  if (override) return override;
  return formatAgentType(agentType);
}

/** CLI agent types in alphabetical order by label */
export const AGENT_TYPE_LIST: CliAgentType[] = [
  CLI_AGENT.KIRO, // Kiro CLI
  CLI_AGENT.CLAUDE_CODE, // Claude Code
  CLI_AGENT.CODEX, // Codex
  CLI_AGENT.CURSOR, // Cursor
  CLI_AGENT.COPILOT, // GitHub Copilot
  CLI_AGENT.OPENCODE, // OpenCode
];

/** API key provider types in alphabetical order by label */
export const API_KEY_PROVIDER_LIST: ApiProviderType[] = [
  "anthropic_api", // Anthropic
  "azure_anthropic_api", // Azure Anthropic
  "azure_openai_api", // Azure OpenAI
  "deepseek_api", // DeepSeek
  "gemini_api", // Google Gemini
  "groq_api", // Groq
  "xai_api", // xAI Grok
  "minimax_api", // MiniMax
  "longcat_api", // LongCat
  "moonshot_api", // Kimi Moonshot
  "openai_api", // OpenAI
  "openrouter_api", // OpenRouter
  "dashscope_api", // Qwen
  "orgii_orchestrator", // ORGII (Token Market)
  "vllm_api", // vLLM / Local
  "zenmux_api", // ZenMux
  "zhipu_api", // Zhipu AI
];

const _API_KEY_PROVIDER_SET: ReadonlySet<string> = new Set(
  API_KEY_PROVIDER_LIST
);

/** Check if an agent type is an API key provider (direct API key, not CLI agent) */
export function isApiKeyProvider(agentType: string): boolean {
  return _API_KEY_PROVIDER_SET.has(agentType);
}
