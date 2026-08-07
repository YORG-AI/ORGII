/**
 * Variant Edit Options
 *
 * Walks a model family's variant ids and produces the availability
 * matrix consumed by the variant-edit dropdown UI:
 *
 *  - which reasoning levels appear in the family,
 *  - whether each level has a `fast` variant available,
 *  - whether the family includes a non-thinking ("None") variant,
 *  - the concrete model id corresponding to any
 *    `{ thinking, level, fast }` selection.
 *
 * The dropdown UI uses this to drive the Thinking / Fast switches and
 * the Effort/Reasoning row list without baking model-family specifics
 * into the component.
 */
import {
  MODEL_REASONING_LEVEL,
  type ModelReasoningLevel,
  parseModelVariant,
} from "./modelVariants";

/**
 * Order in which reasoning levels are displayed in the dropdown. Levels
 * the family does not expose are filtered out before rendering. `Baseline`
 * represents the unsuffixed / no-effort variant (e.g. `claude-sonnet-4-6`
 * or `claude-opus-4-6-thinking` with no level token) and is treated as a
 * regular selectable effort alongside Low/Medium/High/etc.
 */
const LEVEL_DISPLAY_ORDER: ModelReasoningLevel[] = [
  MODEL_REASONING_LEVEL.BASELINE,
  MODEL_REASONING_LEVEL.LOW,
  MODEL_REASONING_LEVEL.MEDIUM,
  MODEL_REASONING_LEVEL.HIGH,
  MODEL_REASONING_LEVEL.EXTRA_HIGH,
  MODEL_REASONING_LEVEL.ULTRA,
  MODEL_REASONING_LEVEL.MAX,
  MODEL_REASONING_LEVEL.ULTRACODE,
];

export interface VariantSelection {
  /**
   * `true` when the user wants reasoning to be applied. `false` selects
   * the base / no-reasoning variant (e.g. `gpt-5.5` or `gpt-5.5-none`).
   */
  thinking: boolean;
  /**
   * Reasoning level when `thinking` is `true`. Ignored otherwise.
   */
  level?: ModelReasoningLevel;
  /**
   * Whether the user wants the `fast` flavour. Only honoured when the
   * resolved combination has a fast variant available.
   */
  fast: boolean;
}

export interface VariantEditOptions {
  /** Reasoning levels exposed by the family, in display order. */
  availableLevels: ModelReasoningLevel[];
  /** `true` when the family has a non-thinking base variant. */
  thinkingToggleable: boolean;
  /**
   * `true` when at least one variant in the family has `fast: true`.
   * The UI hides the Fast row entirely when this is false.
   */
  fastAvailableAnywhere: boolean;
  /**
   * Per-(thinking, level) combination: `true` when a `fast` variant
   * exists. The key for the non-thinking case is `false:none`.
   */
  fastAvailable: (selection: VariantSelection) => boolean;
  /**
   * Resolve a selection to the concrete model id; returns `undefined`
   * when no variant in the family matches the selection.
   */
  resolveVariantId: (selection: VariantSelection) => string | undefined;
  /**
   * Parse an existing model id back into a {@link VariantSelection}.
   * Falls back to a `thinking=false, fast=false` selection when the id
   * is not recognised.
   */
  parseSelection: (modelId: string) => VariantSelection;
}

interface IndexedVariant {
  modelId: string;
  thinking: boolean;
  level?: ModelReasoningLevel;
  fast: boolean;
}

function indexVariants(modelIds: readonly string[]): IndexedVariant[] {
  const out: IndexedVariant[] = [];
  for (const modelId of modelIds) {
    const parsed = parseModelVariant(modelId);
    if (parsed) {
      // `thinking` is the parsed thinking flag (Anthropic extended
      // thinking). Effort level is independent — a variant can have
      // a reasoning level without being a thinking variant. Variants
      // with no parsed level (e.g. `claude-opus-4-6-thinking`,
      // `composer-2.5-fast`) are surfaced as the `Baseline` effort row
      // so they appear alongside Low/Medium/High in the dropdown.
      out.push({
        modelId,
        thinking: parsed.thinking,
        level: parsed.reasoning ?? MODEL_REASONING_LEVEL.BASELINE,
        fast: parsed.fast,
      });
      continue;
    }
    // Unparsed ids (e.g. `claude-sonnet-4-6`) are treated as the
    // unsuffixed Baseline variant.
    out.push({
      modelId,
      thinking: false,
      level: MODEL_REASONING_LEVEL.BASELINE,
      fast: false,
    });
  }
  return out;
}

function selectionKey(selection: {
  thinking: boolean;
  level?: ModelReasoningLevel;
  fast: boolean;
}): string {
  // Thinking and effort level are independent dimensions: a non-thinking
  // variant can still carry an effort level (e.g. `claude-opus-4-7-high`).
  // Encode all three orthogonally so the lookup map distinguishes
  // `(thinking=false, level=high)` from `(thinking=false, level=low)`.
  const level = selection.level ?? "none";
  return `${selection.thinking}:${level}:${selection.fast}`;
}

export function buildVariantEditOptions(
  modelIds: readonly string[]
): VariantEditOptions {
  const indexed = indexVariants(modelIds);

  // Effort levels are collected across BOTH thinking and non-thinking
  // variants. After the parser split, a non-thinking Claude variant
  // like `claude-opus-4-7-high` still has `level: "high"`.
  const levelSet = new Set<ModelReasoningLevel>();
  for (const variant of indexed) {
    if (variant.level) levelSet.add(variant.level);
  }
  const availableLevels = LEVEL_DISPLAY_ORDER.filter((level) =>
    levelSet.has(level)
  );

  // Thinking is "toggleable" only when the family exposes both states
  // — at least one thinking variant AND at least one non-thinking
  // variant. Otherwise the switch would be a no-op.
  const hasThinking = indexed.some((variant) => variant.thinking);
  const hasNonThinking = indexed.some((variant) => !variant.thinking);
  const thinkingToggleable = hasThinking && hasNonThinking;
  const fastAvailableAnywhere = indexed.some((variant) => variant.fast);

  const byKey = new Map<string, IndexedVariant>();
  for (const variant of indexed) {
    byKey.set(selectionKey(variant), variant);
  }

  const fastAvailable = (selection: VariantSelection): boolean => {
    return byKey.has(selectionKey({ ...selection, fast: true }));
  };

  const resolveVariantId = (
    selection: VariantSelection
  ): string | undefined => {
    const exact = byKey.get(selectionKey(selection));
    if (exact) return exact.modelId;
    // Fall back to the non-fast counterpart when fast was requested but
    // unavailable for this combination. UI keeps the switch disabled to
    // prevent reaching this branch, but the helper stays safe.
    if (selection.fast) {
      const fallback = byKey.get(selectionKey({ ...selection, fast: false }));
      return fallback?.modelId;
    }
    return undefined;
  };

  const parseSelection = (modelId: string): VariantSelection => {
    const parsed = parseModelVariant(modelId);
    if (!parsed) {
      return {
        thinking: false,
        level: MODEL_REASONING_LEVEL.BASELINE,
        fast: false,
      };
    }
    return {
      thinking: parsed.thinking,
      level: parsed.reasoning ?? MODEL_REASONING_LEVEL.BASELINE,
      fast: parsed.fast,
    };
  };

  return {
    availableLevels,
    thinkingToggleable,
    fastAvailableAnywhere,
    fastAvailable,
    resolveVariantId,
    parseSelection,
  };
}
