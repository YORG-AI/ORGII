import type { ModelTableVariantInfo } from "@src/types/modelTable";
import {
  MODEL_REASONING_LEVEL,
  type ModelReasoningLevel,
  toModelReasoningLevel,
} from "@src/util/modelVariants";

/**
 * Per-base-model default variant resolution.
 *
 * A "default variant" is the concrete variant model id the runtime launches
 * when the user selects a base model family (e.g. `claude-4.6-opus`). The
 * persisted value lives on the key record (`default_variants`); this module
 * computes the *seed* default used when the user has not chosen one yet.
 *
 * Seed rules:
 *  - Cursor families (`composer-*`)      → the `fast` variant
 *  - Claude families (`claude-*`)        → the `high` reasoning variant
 *  - Everything else                     → the `medium` reasoning variant
 *
 * Each rule falls back to the next-best available variant when its preferred
 * variant is absent, and finally to the first variant.
 */

function isCursorBaseModel(baseModel: string): boolean {
  return baseModel.toLowerCase().startsWith("composer-");
}

function isClaudeBaseModel(baseModel: string): boolean {
  return baseModel.toLowerCase().startsWith("claude-");
}

/** Reasoning levels ordered from weakest to strongest. */
const REASONING_RANK: ModelReasoningLevel[] = [
  MODEL_REASONING_LEVEL.NONE,
  MODEL_REASONING_LEVEL.LOW,
  MODEL_REASONING_LEVEL.MEDIUM,
  MODEL_REASONING_LEVEL.HIGH,
  MODEL_REASONING_LEVEL.EXTRA_HIGH,
  MODEL_REASONING_LEVEL.MAX,
  MODEL_REASONING_LEVEL.ULTRACODE,
];

function reasoningOf(
  variant: ModelTableVariantInfo
): ModelReasoningLevel | undefined {
  return toModelReasoningLevel(variant.reasoning);
}

/**
 * Pick the variant whose reasoning level is closest to `target`, preferring
 * the target itself, then the strongest level below it, then the weakest
 * above it.
 */
function pickByReasoning(
  variants: ModelTableVariantInfo[],
  target: ModelReasoningLevel
): ModelTableVariantInfo | undefined {
  const exact = variants.find((variant) => reasoningOf(variant) === target);
  if (exact) return exact;

  const targetRank = REASONING_RANK.indexOf(target);
  const ranked = variants
    .map((variant) => {
      const level = reasoningOf(variant);
      return {
        variant,
        rank: level ? REASONING_RANK.indexOf(level) : -1,
      };
    })
    .filter((entry) => entry.rank >= 0);

  const below = ranked
    .filter((entry) => entry.rank < targetRank)
    .sort((entryA, entryB) => entryB.rank - entryA.rank);
  if (below.length > 0) return below[0].variant;

  const above = ranked
    .filter((entry) => entry.rank > targetRank)
    .sort((entryA, entryB) => entryA.rank - entryB.rank);
  if (above.length > 0) return above[0].variant;

  return undefined;
}

/**
 * Compute the seed default variant model id for one base model family.
 * Returns `undefined` when `variants` is empty.
 */
export function computeSeedDefaultVariant(
  baseModel: string,
  variants: ModelTableVariantInfo[]
): string | undefined {
  if (variants.length === 0) return undefined;

  if (isCursorBaseModel(baseModel)) {
    const fast = variants.find((variant) => variant.fast);
    if (fast) return fast.model;
    return variants[0].model;
  }

  const target = isClaudeBaseModel(baseModel)
    ? MODEL_REASONING_LEVEL.HIGH
    : MODEL_REASONING_LEVEL.MEDIUM;
  const picked = pickByReasoning(variants, target);
  if (picked) return picked.model;

  return variants[0].model;
}

/**
 * Resolve the effective default variant for a base model: the user's
 * persisted choice when present and still valid, otherwise the seed default.
 */
export function resolveDefaultVariant(
  baseModel: string,
  variants: ModelTableVariantInfo[],
  persistedModel: string | undefined
): string | undefined {
  if (
    persistedModel &&
    variants.some((variant) => variant.model === persistedModel)
  ) {
    return persistedModel;
  }
  return computeSeedDefaultVariant(baseModel, variants);
}
