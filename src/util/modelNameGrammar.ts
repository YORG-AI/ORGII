/** Shared model-ID grammar used by grouping and effort-variant parsing. */

/** Longest-first so codex-max wins over codex. */
const GPT_TIER_PREFIXES = [
  "codex-max",
  "codex-mini",
  "nano",
  "mini",
  "codex",
  "astra",
  "sol",
  "terra",
  "luna",
] as const;

const MODEL_VARIANT_SUFFIX_TOKENS = new Set<string>([
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

const CURSOR_HOSTED_MODEL_PREFIX = "cursor-";

export function extractGptModelTier(rest: string): string | undefined {
  for (const tier of GPT_TIER_PREFIXES) {
    if (rest === tier || rest.startsWith(`${tier}-`)) {
      return tier;
    }
  }
  return undefined;
}

export function isModelVariantSuffixToken(token: string): boolean {
  return MODEL_VARIANT_SUFFIX_TOKENS.has(token.toLowerCase());
}

/** Strip KeyVault's `cursor-` hosted prefix before family/variant parsing. */
export function stripCursorHostedModelPrefix(modelName: string): {
  isCursorHosted: boolean;
  coreModelName: string;
} {
  const lower = modelName.toLowerCase();
  if (lower.startsWith(CURSOR_HOSTED_MODEL_PREFIX)) {
    return {
      isCursorHosted: true,
      coreModelName: modelName.slice(CURSOR_HOSTED_MODEL_PREFIX.length),
    };
  }
  return { isCursorHosted: false, coreModelName: modelName };
}

export function withCursorHostedModelPrefix(
  coreModelName: string,
  isCursorHosted: boolean
): string {
  return isCursorHosted
    ? `${CURSOR_HOSTED_MODEL_PREFIX}${coreModelName}`
    : coreModelName;
}
