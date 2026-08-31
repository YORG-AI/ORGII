/**
 * Model label for the raw-prompt panel header.
 *
 * Reasoning effort is not a stored field in ORGII — it is encoded in the model
 * id itself as a variant suffix (`claude-opus-4-7-thinking-xhigh`,
 * `gpt-5.3-codex-high`, `composer-1-fast`). `parseModelVariant` decodes it, so
 * effort is visible for exactly those ids and absent for plain ones
 * (`claude-opus-4.5-20251219`, `gemini-2.0-flash`).
 *
 * Splitting name from variant is what makes this more than a call to
 * `formatModelNameFull`: that formatter *drops* the suffix on Anthropic ids
 * ("Opus 4.7") but *keeps* it on GPT ids ("GPT 5.3 Codex High"), so appending
 * the variant to its output would silently duplicate the effort on one
 * provider and not the other. Formatting the base model instead makes both
 * read the same — `Opus 4.7` + `Extra High · Thinking`, `GPT 5.3 Codex` +
 * `High`.
 */
import { formatModelNameFull } from "@src/util/formatModelName";
import {
  formatVariantDisplayLabel,
  parseModelVariant,
} from "@src/util/modelVariants";

export interface RawPromptModelLabel {
  /** Base model display name, e.g. `Opus 4.7`. */
  name: string;
  /**
   * Variant summary, e.g. `Extra High · Thinking`. Empty when the id encodes
   * no recognized effort/thinking/fast suffix.
   */
  variant: string;
}

export function describeModelLabel(
  model: string | undefined | null
): RawPromptModelLabel | null {
  const modelId = model?.trim();
  if (!modelId) return null;

  const variant = formatVariantDisplayLabel(modelId);
  // No recognized variant — format the id whole so an unmapped suffix
  // (`ModelVariantMetadata.rawSuffix`) is never dropped on the floor.
  if (!variant) return { name: formatModelNameFull(modelId), variant: "" };

  const baseModel = parseModelVariant(modelId)?.baseModel ?? modelId;
  return { name: formatModelNameFull(baseModel), variant };
}
