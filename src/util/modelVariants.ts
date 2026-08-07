import { extractGptModelTier } from "./modelGrouping";

export const MODEL_REASONING_LEVEL = {
  NONE: "none",
  BASELINE: "baseline",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  EXTRA_HIGH: "extra_high",
  ULTRA: "ultra",
  MAX: "max",
  ULTRACODE: "ultracode",
} as const;

export type ModelReasoningLevel =
  (typeof MODEL_REASONING_LEVEL)[keyof typeof MODEL_REASONING_LEVEL];

export interface ModelVariantMetadata {
  model: string;
  baseModel: string;
  /**
   * Reasoning effort level (e.g. `low`, `high`, `extra_high`). Independent
   * of {@link thinking}: a Claude variant like `claude-opus-4-7-thinking-xhigh`
   * has `reasoning: "extra_high"` AND `thinking: true` — `thinking` is the
   * extended-thinking dimension, not a reasoning level of its own.
   */
  reasoning?: ModelReasoningLevel;
  /**
   * Whether the variant enables extended thinking. A separate dimension
   * from {@link reasoning} and {@link fast}; primarily an Anthropic
   * concept (the `thinking` suffix token).
   */
  thinking: boolean;
  fast: boolean;
  /**
   * Original reasoning-level suffix tokens (excluding `fast` AND
   * `thinking`) joined by `-`, e.g. `xhigh` or `max`. Used as a display
   * fallback when the suffix does not map to a known reasoning level.
   */
  rawSuffix?: string;
}

const GPT_BASE_PATTERN = /^(gpt-\d+(?:\.\d+)?)(?:-(.+))?$/i;
const COMPOSER_BASE_PATTERN = /^(composer-\d+(?:\.\d+)?)(?:-(.+))?$/i;
const O_SERIES_BASE_PATTERN = /^o(\d+(?:\.\d+)?)(?:-(.+))?$/i;

const VARIANT_SUFFIX_TOKENS = new Set<string>([
  "none",
  "low",
  "medium",
  "high",
  "extra",
  "extra-high",
  "xhigh",
  "ultra",
  "max",
  "ultracode",
  "minimal",
  "thinking",
  "fast",
]);

function normalizeReasoning(
  value: string | undefined
): ModelReasoningLevel | undefined {
  if (!value) return undefined;
  if (value === "extra-high") return MODEL_REASONING_LEVEL.EXTRA_HIGH;
  if (value === "xhigh") return MODEL_REASONING_LEVEL.EXTRA_HIGH;
  if (value === MODEL_REASONING_LEVEL.NONE) return MODEL_REASONING_LEVEL.NONE;
  if (value === MODEL_REASONING_LEVEL.LOW) return MODEL_REASONING_LEVEL.LOW;
  if (value === MODEL_REASONING_LEVEL.MEDIUM)
    return MODEL_REASONING_LEVEL.MEDIUM;
  if (value === MODEL_REASONING_LEVEL.HIGH) return MODEL_REASONING_LEVEL.HIGH;
  if (value === MODEL_REASONING_LEVEL.EXTRA_HIGH)
    return MODEL_REASONING_LEVEL.EXTRA_HIGH;
  if (value === MODEL_REASONING_LEVEL.ULTRA) return MODEL_REASONING_LEVEL.ULTRA;
  if (value === MODEL_REASONING_LEVEL.MAX) return MODEL_REASONING_LEVEL.MAX;
  if (value === MODEL_REASONING_LEVEL.ULTRACODE)
    return MODEL_REASONING_LEVEL.ULTRACODE;
  return undefined;
}

function collectSuffixTokens(
  segments: string[],
  minBaseLength: number
): {
  baseSegments: string[];
  suffixTokens: string[];
} {
  const baseSegments = [...segments];
  const suffixTokens: string[] = [];
  while (baseSegments.length > minBaseLength) {
    const last = baseSegments.at(-1);
    if (!last || !VARIANT_SUFFIX_TOKENS.has(last)) break;
    suffixTokens.unshift(last);
    baseSegments.pop();
  }
  return { baseSegments, suffixTokens };
}

function mergeCompoundTokens(tokens: string[]): string[] {
  const merged: string[] = [];
  for (let cursor = 0; cursor < tokens.length; cursor += 1) {
    if (tokens[cursor] === "extra" && tokens[cursor + 1] === "high") {
      merged.push("extra-high");
      cursor += 1;
      continue;
    }
    merged.push(tokens[cursor]);
  }
  return merged;
}

function buildVariant(
  model: string,
  baseModel: string,
  rawSuffixTokens: string[]
): ModelVariantMetadata | undefined {
  if (rawSuffixTokens.length === 0) return undefined;

  const suffixTokens = mergeCompoundTokens(rawSuffixTokens);
  const fast = suffixTokens.includes("fast");
  const thinking = suffixTokens.includes("thinking");

  // `thinking` and `fast` are orthogonal dimensions — the reasoning level
  // is whatever remains. e.g. `thinking-xhigh` → reasoning `xhigh`,
  // thinking `true`; a lone `thinking` suffix has no explicit level.
  const reasoningToken = suffixTokens.find(
    (token) => token !== "fast" && token !== "thinking"
  );
  if (!reasoningToken && !fast && !thinking) return undefined;

  const rawSuffix = reasoningToken ?? undefined;

  return {
    model,
    baseModel,
    reasoning: normalizeReasoning(reasoningToken),
    thinking,
    fast,
    rawSuffix,
  };
}

function parseClaudeVariant(model: string): ModelVariantMetadata | undefined {
  const lower = model.toLowerCase();
  if (!lower.startsWith("claude-")) return undefined;

  const { baseSegments, suffixTokens } = collectSuffixTokens(
    lower.split("-"),
    1
  );
  return buildVariant(model, baseSegments.join("-"), suffixTokens);
}

/**
 * Provider-native OpenAI-compatible families (GLM/Zhipu, Grok/xAI) whose ids
 * carry ORG2 effort suffixes directly from the provider list (e.g.
 * `glm-5.2-high`, `grok-4.5-max`). These have no dedicated tier grammar like
 * GPT's `codex-max`, so a straight suffix-peel — mirroring the Rust
 * `parse_model_variant` in agent-core `thinking_mode.rs` — is correct and keeps
 * both sides in agreement. Bare ids (`glm-5.2`) peel nothing → `undefined`.
 */
const SUFFIX_PARSED_FAMILY_PREFIXES = ["glm-", "grok-"] as const;

function parseSuffixOnlyFamilyVariant(
  model: string
): ModelVariantMetadata | undefined {
  const lower = model.toLowerCase();
  if (
    !SUFFIX_PARSED_FAMILY_PREFIXES.some((prefix) => lower.startsWith(prefix))
  ) {
    return undefined;
  }
  const { baseSegments, suffixTokens } = collectSuffixTokens(
    lower.split("-"),
    1
  );
  return buildVariant(model, baseSegments.join("-"), suffixTokens);
}

function parseGptVariant(model: string): ModelVariantMetadata | undefined {
  const lower = model.toLowerCase();
  const baseMatch = lower.match(GPT_BASE_PATTERN);
  if (!baseMatch) return undefined;

  const baseRoot = baseMatch[1];
  const suffix = baseMatch[2];
  if (!suffix) return undefined;

  const tier = extractGptModelTier(suffix);
  let baseModel = baseRoot;
  let reasoningSuffix = suffix;

  if (tier) {
    baseModel = `${baseRoot}-${tier}`;
    reasoningSuffix = suffix === tier ? "" : suffix.slice(tier.length + 1);
  }

  if (!reasoningSuffix) return undefined;

  const { baseSegments, suffixTokens } = collectSuffixTokens(
    reasoningSuffix.split("-"),
    0
  );
  const finalBaseModel =
    baseSegments.length > 0
      ? `${baseModel}-${baseSegments.join("-")}`
      : baseModel;
  return buildVariant(model, finalBaseModel, suffixTokens);
}

function parseComposerVariant(model: string): ModelVariantMetadata | undefined {
  const lower = model.toLowerCase();
  const baseMatch = lower.match(COMPOSER_BASE_PATTERN);
  if (!baseMatch) return undefined;

  const baseModel = baseMatch[1];
  const suffix = baseMatch[2];
  if (suffix !== "fast") return undefined;

  return buildVariant(model, baseModel, [suffix]);
}

const O_SERIES_SIZE_SUFFIXES = new Set(["mini", "nano"]);

function parseOSeriesVariant(model: string): ModelVariantMetadata | undefined {
  const lower = model.toLowerCase();
  const baseMatch = lower.match(O_SERIES_BASE_PATTERN);
  if (!baseMatch) return undefined;

  const versionRoot = `o${baseMatch[1]}`;
  const suffix = baseMatch[2];
  if (!suffix) return undefined;

  const segments = suffix.split("-");
  if (segments.length === 1 && O_SERIES_SIZE_SUFFIXES.has(segments[0])) {
    return {
      model,
      baseModel: versionRoot,
      reasoning: undefined,
      thinking: false,
      fast: false,
      rawSuffix: segments[0],
    };
  }

  const { baseSegments, suffixTokens } = collectSuffixTokens(segments, 0);
  const baseModel =
    baseSegments.length > 0
      ? `${versionRoot}-${baseSegments.join("-")}`
      : versionRoot;
  return buildVariant(model, baseModel, suffixTokens);
}

export function parseModelVariant(
  model: string
): ModelVariantMetadata | undefined {
  const gptVariant = parseGptVariant(model);
  if (gptVariant) return gptVariant;

  const composerVariant = parseComposerVariant(model);
  if (composerVariant) return composerVariant;

  const oSeriesVariant = parseOSeriesVariant(model);
  if (oSeriesVariant) return oSeriesVariant;

  if (model.toLowerCase().startsWith("claude-")) {
    return parseClaudeVariant(model);
  }

  // Provider-native families (GLM/Zhipu, Grok/xAI) whose effort suffixes come
  // straight from the provider list. Mirrors the Rust `parse_model_variant`
  // so both sides agree on base/effort splits. Other families (Gemini, etc.)
  // intentionally stay unparsed.
  return parseSuffixOnlyFamilyVariant(model);
}

export function parseModelVariants(models: string[]): ModelVariantMetadata[] {
  return models
    .map(parseModelVariant)
    .filter(
      (variant): variant is ModelVariantMetadata => variant !== undefined
    );
}

export function getModelVariantBaseModel(model: string): string {
  return parseModelVariant(model)?.baseModel ?? model;
}

export function toModelReasoningLevel(
  value: string | null | undefined
): ModelReasoningLevel | undefined {
  return normalizeReasoning(value ?? undefined);
}

export function formatReasoningLevel(
  level: ModelReasoningLevel | undefined
): string {
  switch (level) {
    case MODEL_REASONING_LEVEL.NONE:
      return "None";
    case MODEL_REASONING_LEVEL.BASELINE:
      return "Baseline";
    case MODEL_REASONING_LEVEL.LOW:
      return "Light";
    case MODEL_REASONING_LEVEL.MEDIUM:
      return "Medium";
    case MODEL_REASONING_LEVEL.HIGH:
      return "High";
    case MODEL_REASONING_LEVEL.EXTRA_HIGH:
      return "Extra High";
    case MODEL_REASONING_LEVEL.ULTRA:
      return "Ultra";
    case MODEL_REASONING_LEVEL.MAX:
      return "Max";
    case MODEL_REASONING_LEVEL.ULTRACODE:
      return "Ultracode";
    default:
      return "—";
  }
}

export function modelVariantsByModel(
  variants: ModelVariantMetadata[] | undefined
): Map<string, ModelVariantMetadata> {
  return new Map((variants ?? []).map((variant) => [variant.model, variant]));
}

/**
 * Build a compact display label for a variant in the form
 * `Extra High · Thinking · Fast`. Omits any segment whose value is
 * falsy: a variant with `reasoning: "extra_high"`, `thinking: false`,
 * `fast: true` renders as `Extra High · Fast`. Returns `undefined` when
 * the model id has no recognised variant suffix and no segments survive.
 */
export function formatVariantDisplayLabel(modelId: string): string | undefined {
  const variant = parseModelVariant(modelId);
  if (!variant) return undefined;
  const parts: string[] = [];
  if (variant.reasoning) parts.push(formatReasoningLevel(variant.reasoning));
  if (variant.thinking) parts.push("Thinking");
  if (variant.fast) parts.push("Fast");
  if (parts.length === 0) return undefined;
  return parts.join(" · ");
}

export interface ResolvedModelVariantFields {
  model: string;
  base_model: string;
  reasoning?: string | null;
  fast: boolean;
  context_window?: number | null;
}

/** Frontend parse wins over backend model_variants wire metadata. */
export function resolveModelVariantFields(
  model: string,
  fallback?: ResolvedModelVariantFields
): ResolvedModelVariantFields {
  const parsed = parseModelVariant(model);
  if (parsed) {
    return {
      model: parsed.model,
      base_model: parsed.baseModel,
      reasoning: parsed.reasoning ?? null,
      fast: parsed.fast,
      context_window: fallback?.context_window,
    };
  }
  if (fallback) {
    return fallback;
  }
  return { model, base_model: model, fast: false };
}

export function groupHasParsedModelVariants(
  models: readonly string[]
): boolean {
  return models.some((model) => parseModelVariant(model) !== undefined);
}
