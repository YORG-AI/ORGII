/**
 * Model Info Registry
 *
 * Static descriptive metadata about common LLMs (Anthropic Claude, OpenAI
 * GPT/o-series, Google Gemini, DeepSeek, Meta Llama, xAI Grok, Mistral, Qwen,
 * GitHub Copilot, Cursor's own composer).
 *
 * Used by `<ContextInfoButton />` to read each model's `contextWindow` for
 * the chat-input token-budget gauge. The richer fields (`provider`,
 * `providerKey`, `vision`, `reasoning`, `strengthKeys`, `pricingTier`) are
 * preserved so that future UI surfaces (model cards, pickers) can pick them
 * up without another data migration.
 *
 * NOTE: there are two unrelated `ModelInfo` types in this codebase —
 *   1. `import type { ModelInfo } from "@src/types/model/info";`  ← this file
 *      Static frontend descriptor (provider brand, context window, etc.)
 *   2. `import type { ModelInfo } from "@src/api/http/config";`
 *      Embedding-model wire row used by the indexing settings page.
 * They are NOT interchangeable. Consumers must pick the right one by
 * import path.
 *
 * Per-provider registry entries live in the co-located `info.<provider>.ts`
 * modules (`info.anthropic.ts`, `info.openai.ts`, etc.); shared types live
 * in `info.types.ts`. Both are re-exported/aggregated below so the public
 * import path (`@src/types/model/info`) is unchanged.
 */
import { ANTHROPIC_MODEL_INFO_ENTRIES } from "@src/types/model/info.anthropic";
import { COPILOT_MODEL_INFO_ENTRIES } from "@src/types/model/info.copilot";
import { CURSOR_MODEL_INFO_ENTRIES } from "@src/types/model/info.cursor";
import { DEEPSEEK_MODEL_INFO_ENTRIES } from "@src/types/model/info.deepseek";
import { GOOGLE_MODEL_INFO_ENTRIES } from "@src/types/model/info.google";
import { META_MODEL_INFO_ENTRIES } from "@src/types/model/info.meta";
import { MISTRAL_MODEL_INFO_ENTRIES } from "@src/types/model/info.mistral";
import { OPENAI_MODEL_INFO_ENTRIES } from "@src/types/model/info.openai";
import { QWEN_MODEL_INFO_ENTRIES } from "@src/types/model/info.qwen";
import type {
  ModelInfo,
  ModelInfoEntry,
  PricingTier,
} from "@src/types/model/info.types";
import { XAI_MODEL_INFO_ENTRIES } from "@src/types/model/info.xai";
import { ZAI_MODEL_INFO_ENTRIES } from "@src/types/model/info.zai";

export type { ModelInfo, PricingTier };

/**
 * Patterns are matched against model category strings from the API.
 * More specific patterns come before generic ones; the first
 * `lower.includes(pattern)` hit wins.
 *
 * Assembled from the per-provider registries above, in the same provider
 * order as the header doc comment.
 */
const MODEL_INFO_ENTRIES: ModelInfoEntry[] = [
  ...ANTHROPIC_MODEL_INFO_ENTRIES,
  ...OPENAI_MODEL_INFO_ENTRIES,
  ...CURSOR_MODEL_INFO_ENTRIES,
  ...GOOGLE_MODEL_INFO_ENTRIES,
  ...DEEPSEEK_MODEL_INFO_ENTRIES,
  ...META_MODEL_INFO_ENTRIES,
  ...XAI_MODEL_INFO_ENTRIES,
  ...MISTRAL_MODEL_INFO_ENTRIES,
  ...QWEN_MODEL_INFO_ENTRIES,
  ...ZAI_MODEL_INFO_ENTRIES,
  ...COPILOT_MODEL_INFO_ENTRIES,
];

/**
 * Look up model info by category string from the API.
 * Uses prefix/substring matching against registered patterns.
 * Returns the first (most specific) match, or null if no match.
 */
function normalizeModelInfoCategory(category: string): string {
  return category
    .toLowerCase()
    .replace(/claude-opus-4-6/g, "claude-opus-4.6")
    .replace(/claude-opus-4-7/g, "claude-opus-4.7")
    .replace(/claude-opus-4-8/g, "claude-opus-4.8")
    .replace(/claude-sonnet-4-5/g, "claude-sonnet-4.5")
    .replace(/claude-sonnet-4-6/g, "claude-sonnet-4.6");
}

export function getModelInfo(category: string): ModelInfo | null {
  const lower = normalizeModelInfoCategory(category);
  for (const entry of MODEL_INFO_ENTRIES) {
    if (lower.includes(entry.pattern)) {
      return entry.info;
    }
  }
  return null;
}
