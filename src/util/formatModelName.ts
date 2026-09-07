/**
 * Format a raw model ID into a human-readable display name.
 *
 * Handles:
 * - Trailing date stamps: `-20251219`, `-2024-08-06`, `-latest`
 * - Long hex hashes embedded in the slug
 * - Consecutive digit segments merged as versions: `3-5` → `3.5`
 * - Title-casing with special uppercase for GPT / O-series
 *
 * Examples:
 *   claude-opus-4.5-20251219   → Opus 4.5
 *   claude-3-5-sonnet-20241022 → Sonnet 3.5
 *   gpt-4-turbo-2024-04-09     → GPT 4 Turbo
 *   gpt-5.3-codex              → GPT 5.3 Codex
 *   o3-mini-2025-01-31          → O3 Mini
 *   gemini-2.0-flash            → Gemini 2.0 Flash
 */
import { getModelAliasDisplayName } from "@src/hooks/models/modelAliasRegistry";

import { groupModels } from "./modelGrouping";
import { formatReasoningLevel, parseModelVariant } from "./modelVariants";

const UPPERCASE_TOKENS = new Set(["gpt", "o1", "o3", "o4"]);
const TRAILING_JUNK_RE = /(?:-\d{8,}|-\d{4}-\d{2}-\d{2}|-latest)$/;
const CLAUDE_MODEL_NAMES = new Set([
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "mythos",
]);

function formatClaudeModelName(cleanedModel: string): string | undefined {
  if (!cleanedModel.toLowerCase().startsWith("claude")) return undefined;

  const parts = cleanedModel
    .toLowerCase()
    .replace(/^claude-?/, "")
    .split("-")
    .filter(Boolean);
  const modelName = parts.find((part) => CLAUDE_MODEL_NAMES.has(part));
  const modelLabel = modelName
    ? modelName.charAt(0).toUpperCase() + modelName.slice(1)
    : undefined;

  // When no canonical Anthropic model name is present (sonnet / haiku / opus),
  // surface the first non-numeric codename segment so e.g. `claude-fable-5`
  // formats as "Claude Fable 5" instead of bare "Claude 5".
  const codename = modelLabel
    ? undefined
    : parts.find((part) => !/^\d+(\.\d+)?$/.test(part));
  const codeLabel = codename
    ? codename.charAt(0).toUpperCase() + codename.slice(1)
    : undefined;

  const familyPrefix =
    modelLabel ?? (codeLabel ? `Claude ${codeLabel}` : "Claude");

  const decimalVersion = parts.find((part) => /^\d+\.\d+$/.test(part));
  if (decimalVersion) {
    return `${familyPrefix} ${decimalVersion}`;
  }

  const integerParts = parts.filter((part) => /^\d+$/.test(part));
  if (integerParts.length >= 2) {
    const version = `${integerParts[0]}.${integerParts[1]}`;
    return `${familyPrefix} ${version}`;
  }
  if (integerParts.length === 1) {
    return `${familyPrefix} ${integerParts[0]}`;
  }

  return familyPrefix;
}

export function formatModelName(model: string): string {
  if (!model || model === "default") return model;

  const cleaned = model.replace(TRAILING_JUNK_RE, "");
  const claudeName = formatClaudeModelName(cleaned);
  if (claudeName) return claudeName;

  const parts = cleaned.split("-");

  const filtered: string[] = [];
  for (const part of parts) {
    if (/^\d{6,}$/.test(part)) continue;
    if (part.length > 12 && /^[a-z0-9]+$/.test(part)) continue;
    filtered.push(part);
  }

  const merged: string[] = [];
  for (const part of filtered) {
    const prev = merged[merged.length - 1];
    if (prev && /^\d+$/.test(prev) && /^\d+$/.test(part)) {
      merged[merged.length - 1] = `${prev}.${part}`;
    } else {
      merged.push(part);
    }
  }

  const formatted = merged
    .map((part) => {
      if (/^\d/.test(part)) return part;
      if (UPPERCASE_TOKENS.has(part.toLowerCase())) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");

  return compactModelLabel(formatted);
}

/**
 * Like formatModelName but preserves trailing date suffixes.
 *
 * Examples:
 *   gpt-5.2-2025-12-11   → GPT 5.2 2025-12-11
 *   claude-opus-4.5-20251219 → Opus 4.5 20251219
 *   o3-mini-2025-01-31   → O3 Mini 2025-01-31
 *   gemini-2.0-flash     → Gemini 2.0 Flash
 */
export function formatModelNameFull(model: string): string {
  if (!model || model === "default") return model;

  const dateMatch = model.match(TRAILING_JUNK_RE);
  const baseName = formatModelName(model);
  if (!dateMatch) return baseName;

  const raw = dateMatch[0].replace(/^-/, "");
  return `${baseName} ${raw}`;
}

/**
 * Strip redundant provider prefix from an already-formatted model label.
 *
 * "Claude" is stripped because Opus / Sonnet / Haiku are self-identifying.
 * "GPT", "Gemini", "O3" etc. are kept — they ARE the identifier.
 *
 * Works on any label source (API display_name, formatModelName output, etc.).
 *
 * Examples:
 *   Claude Opus 4.5   → Opus 4.5
 *   Claude 3.5 Sonnet  → Sonnet 3.5
 *   GPT 4 Turbo        → GPT 4 Turbo  (unchanged)
 *   Gemini 2.0 Flash   → Gemini 2.0 Flash  (unchanged)
 */
const CLAUDE_LABEL_RE =
  /^Claude\s+(?:(Opus|Sonnet|Haiku)\s+(.+)|(.+)\s+(Opus|Sonnet|Haiku))$/i;
const STRIP_PREFIX_RE = /^Claude\s+/i;

function normalizeClaudeFamilyLabel(label: string): string | undefined {
  const match = label.match(CLAUDE_LABEL_RE);
  if (!match) return undefined;

  const leadingFamily = match[1];
  const leadingVersion = match[2];
  const trailingVersion = match[3];
  const trailingFamily = match[4];
  const family = leadingFamily ?? trailingFamily;
  const version = leadingVersion ?? trailingVersion;
  if (!family || !version) return undefined;

  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${version}`;
}

export function compactModelLabel(label: string): string {
  return (
    normalizeClaudeFamilyLabel(label) ?? label.replace(STRIP_PREFIX_RE, "")
  );
}

// ─── Version-aware sorting ───────────────────────────────────────────────────

function extractModelVersion(modelId: string): {
  family: string;
  version: number;
} {
  const cleaned = modelId.replace(TRAILING_JUNK_RE, "");
  const versionMatch = cleaned.match(/(\d+\.\d+)/);
  const version = versionMatch ? parseFloat(versionMatch[1]) : 0;
  const family = versionMatch
    ? cleaned
        .slice(0, versionMatch.index)
        .replace(/[-\s]+$/, "")
        .toLowerCase()
    : cleaned.toLowerCase();
  return { family, version };
}

/**
 * Compare two model IDs for sorting: same family -> higher version first,
 * different family -> alphabetical. Trailing dates are stripped so
 * "gpt-5.4" correctly sorts above "gpt-5.2-2025-12-11".
 */
export function compareModelsByVersion(idA: string, idB: string): number {
  const sortKeyA = extractModelVersion(idA);
  const sortKeyB = extractModelVersion(idB);
  if (sortKeyA.family === sortKeyB.family) {
    if (sortKeyB.version !== sortKeyA.version)
      return sortKeyB.version - sortKeyA.version;
    return idA.localeCompare(idB);
  }
  return sortKeyA.family.localeCompare(sortKeyB.family);
}

// ─── Shared model display resolution ─────────────────────────────────────────

interface ModelSelection {
  model?: string;
  provider?: string;
  listingModel?: string;
  listingModelDisplay?: string;
  listingName?: string;
  selectedSourceLabel?: string;
}

export interface ModelPillDisplayParts {
  label: string;
  rawValue?: string;
  variantInfo?: string;
  thinking: boolean;
}

interface ProviderWithModels {
  provider_name: string;
  models: { id: string; display_name: string }[];
}

/**
 * Resolve a model selection to a compact, normalized display label.
 *
 * Tries (in order): listingModelDisplay → listingName → listingModel →
 * provider-matched display_name → any-provider display_name → formatModelNameFull.
 *
 * Raw model IDs are normalized with formatModelNameFull (title-cased, trailing
 * date stamps preserved) before compactModelLabel.
 *
 * Used by: ControlButtons (via useModelPillLabel), other surfaces needing
 * listing/tier-aware labels.
 */
export function resolveModelDisplayLabel(
  selection: ModelSelection,
  providers: ProviderWithModels[],
  fallback: string = "Model"
): string {
  if (selection.listingModelDisplay) {
    return compactModelLabel(selection.listingModelDisplay);
  }
  if (selection.listingName) {
    return compactModelLabel(selection.listingName);
  }
  if (selection.listingModel) {
    const alias = getModelAliasDisplayName(selection.listingModel);
    if (alias) return alias;
    return compactModelLabel(formatModelNameFull(selection.listingModel));
  }

  if (!selection.model) return fallback;

  const alias = getModelAliasDisplayName(selection.model);
  if (alias) return alias;

  if (selection.provider) {
    const provider = providers.find(
      (prov) => prov.provider_name === selection.provider
    );
    const model = provider?.models.find((mod) => mod.id === selection.model);
    if (model) return compactModelLabel(formatModelNameFull(model.id));
  }

  for (const provider of providers) {
    const model = provider.models.find((mod) => mod.id === selection.model);
    if (model) return compactModelLabel(formatModelNameFull(model.id));
  }

  return compactModelLabel(formatModelNameFull(selection.model));
}

function resolveModelGroupLabel(modelId: string): string {
  const variant = parseModelVariant(modelId);
  const displayModelId = variant?.baseModel ?? modelId;
  const alias = getModelAliasDisplayName(displayModelId);
  if (alias) return alias;

  const groupedModel = groupModels([displayModelId])[0];
  if (groupedModel && groupedModel.label !== "Other") return groupedModel.label;

  return formatModelNameFull(displayModelId);
}

export function resolveModelPillDisplayParts(
  selection: ModelSelection,
  fallback: string = "Model"
): ModelPillDisplayParts {
  const modelId = selection.model || selection.listingModel;
  if (!modelId) {
    return { label: fallback, thinking: false };
  }

  const variant = parseModelVariant(modelId);
  const variantParts: string[] = [];
  if (variant?.reasoning)
    variantParts.push(formatReasoningLevel(variant.reasoning));
  if (variant?.fast) variantParts.push("Fast");

  return {
    label: resolveModelGroupLabel(modelId),
    rawValue: modelId,
    variantInfo: variantParts.length > 0 ? variantParts.join(" · ") : undefined,
    thinking: Boolean(variant?.thinking),
  };
}

/** Account / source label for model-pill breadcrumb tooltips. */
export function resolveModelPillAccountName(
  selection: ModelSelection
): string | undefined {
  if (selection.selectedSourceLabel) return selection.selectedSourceLabel;
  if (selection.listingName) return selection.listingName;
  return undefined;
}

/**
 * Like resolveModelDisplayLabel but preserves date suffixes.
 * Used for tooltips / hover states where the full version info is useful.
 */
export function resolveModelFullLabel(
  selection: ModelSelection,
  fallback: string = "Model"
): string {
  if (selection.listingModelDisplay) {
    return compactModelLabel(selection.listingModelDisplay);
  }
  if (selection.listingName) {
    return compactModelLabel(selection.listingName);
  }
  if (selection.listingModel) {
    const alias = getModelAliasDisplayName(selection.listingModel);
    if (alias) return alias;
    return formatModelNameFull(selection.listingModel);
  }

  if (!selection.model) return fallback;

  const alias = getModelAliasDisplayName(selection.model);
  if (alias) return alias;

  return formatModelNameFull(selection.model);
}
