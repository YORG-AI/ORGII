import type {
  CliAgentType,
  ModelType,
} from "@src/api/tauri/rpc/schemas/validation";
import { type DispatchCategory, KEY_SOURCE } from "@src/api/tauri/session";
import { CLI_AGENT } from "@src/api/types/keys";
import type { AdvancedConfig } from "@src/features/SessionCreator/types";

function isBigThreeApiProvider(
  src: ModelType | undefined
): src is "openai_api" | "anthropic_api" | "gemini_api" {
  return (
    src === "openai_api" || src === "anthropic_api" || src === "gemini_api"
  );
}

/**
 * Resolves which OpenAI / Anthropic / Google region policy applies for the
 * session creator hero selection. Returns "" when the user is not on own key,
 * has no model, or the selection is not one of those providers (incl. CLI
 * Codex / Claude Code).
 */
export function getBigThreeRegionModelTypeForSession(
  dispatchCategory: DispatchCategory,
  advancedConfig: AdvancedConfig,
  cliAgentTypeFromAtom: CliAgentType | null
): ModelType | "" {
  if (advancedConfig.keySource !== KEY_SOURCE.OWN) return "";

  const hasModel = Boolean(advancedConfig.model || advancedConfig.listingModel);
  if (!hasModel) return "";

  if (dispatchCategory === "cli_agent") {
    const cli =
      advancedConfig.cliAgentType ?? cliAgentTypeFromAtom ?? undefined;
    if (!cli) return "";
    if (cli === CLI_AGENT.CODEX || cli === CLI_AGENT.CLAUDE_CODE) {
      return cli as ModelType;
    }
    return "";
  }

  if (dispatchCategory === "rust_agent") {
    const src = advancedConfig.selectedSourceModelType;
    if (isBigThreeApiProvider(src)) {
      return src;
    }
    return "";
  }

  return "";
}

/** English product names for monitor.regionRestricted (matches getRestrictedProviders). */
export function bigThreeProviderLabelForModelType(
  modelType: ModelType | ""
): string {
  switch (modelType) {
    case "openai_api":
    case "codex":
      return "OpenAI";
    case "anthropic_api":
    case "claude_code":
      return "Anthropic";
    case "gemini_api":
      return "Google";
    default:
      return "";
  }
}
