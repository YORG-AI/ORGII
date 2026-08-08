import {
  type AutoDetectResult,
  type ModelType,
  autoDetectKey,
} from "@src/api/services/keyValidation";
import {
  externalHistoryRescanSource,
  fetchExternalSourceStats,
} from "@src/api/tauri/externalHistory";
import type { SetupWalkthroughProgress } from "@src/config/settingsSchema/setupWalkthroughProgress";
import { loadSessionRoster } from "@src/store/session";

export type SetupToolSummary = SetupWalkthroughProgress["tools"][number];

const TOOL_TYPES = ["codex", "claude_code", "cursor_cli"] as const;

/**
 * Convert the secret-bearing detection RPC into the only shape onboarding is
 * allowed to retain. API keys, tokens, environment values and account
 * metadata are discarded in the same synchronous turn.
 */
export function sanitizeDetectedTool(
  agentType: SetupToolSummary["agentType"],
  result: AutoDetectResult
): SetupToolSummary {
  return {
    agentType,
    found: result.success && result.keys.length > 0,
    keyCount: result.keys.length,
    validatedCount: result.keys.filter((key) => key.validated === true).length,
  };
}

export async function detectSetupTools(
  detect: (agentType: ModelType) => Promise<AutoDetectResult> = autoDetectKey
): Promise<SetupToolSummary[]> {
  const settled = await Promise.allSettled(
    TOOL_TYPES.map(async (agentType) =>
      sanitizeDetectedTool(agentType, await detect(agentType))
    )
  );
  return settled.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : {
          agentType: TOOL_TYPES[index],
          found: false,
          keyCount: 0,
          validatedCount: 0,
        }
  );
}

/**
 * Explicit, source-scoped Codex import. The shared rescan service coalesces
 * concurrent callers; a roster reload happens only when the cache changed.
 */
export async function importCodexHistory(): Promise<number> {
  const result = await externalHistoryRescanSource("codex_app");
  if (result.changedSources.length > 0) {
    await loadSessionRoster({ forceRefresh: true });
  }
  const stats = await fetchExternalSourceStats("codex_app");
  return stats.sessionCount;
}
