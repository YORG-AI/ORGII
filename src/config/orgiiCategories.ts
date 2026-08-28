/**
 * ORGII pool model category configuration.
 *
 * UI-only config (badge styles) lives here.
 * Business logic (classification patterns, prices) comes from
 * the backend via GET /config/orgii-pool — see getORGIIPoolConfig().
 *
 * Categories are fully dynamic — the backend defines the list and the
 * frontend renders whatever it receives. No hardcoded tier names.
 */
import { FlashIcon, type IconSvgElement } from "@src/icons";
import type { ORGIIPoolCategory, ORGIIPoolConfig } from "@src/types/model/pool";
import { formatModelNameFull } from "@src/util/formatModelName";

// ─── ORGII tier constants ─────────────────────────────────────────────────────

const ORGII_TIER_PREFIX = "orgii:";

/**
 * Per-tier icon mapping. Empty in the OSS build (no hosted pool, no tiers).
 * The hosted build populates this with whatever tier ids it serves.
 */
export const ORGII_TIER_ICONS: Record<string, IconSvgElement> = {};

/**
 * Fallback tiers used when the hosted pool config has not yet returned (or
 * is unavailable). The OSS build has no hosted pool, so this is empty —
 * consumers (Spotlight model palette, Integrations Models table) collapse
 * to their "no tiers" rendering path.
 */
export const ORGII_FALLBACK_TIERS: ORGIIPoolCategory[] = [];

export function isOrgiiTierModel(modelId: string): boolean {
  return modelId.startsWith(ORGII_TIER_PREFIX);
}

export function parseOrgiiTierId(modelId: string): string {
  return modelId.slice(ORGII_TIER_PREFIX.length);
}

export function getOrgiiTierIcon(tierId: string): IconSvgElement {
  return ORGII_TIER_ICONS[tierId] ?? FlashIcon;
}

/**
 * Badge style for a category, derived from its list index position.
 * Cheapest = green, mid = blue, expensive = purple.
 */
const BADGE_STYLES = [
  "bg-green-500/10 text-green-500 border-green-500/20",
  "bg-blue-500/10 text-blue-500 border-blue-500/20",
  "bg-purple-500/10 text-purple-500 border-purple-500/20",
  "bg-red-500/10 text-red-500 border-red-500/20",
  "bg-amber-500/10 text-amber-500 border-amber-500/20",
];

export function getBadgeClass(categoryIndex: number): string {
  return BADGE_STYLES[categoryIndex % BADGE_STYLES.length];
}

/**
 * Get the i18n label key for a category.
 * Maps category id to `orgiiOrchestrator.{id}.name`.
 */
export function getCategoryLabelKey(categoryId: string): string {
  return `orgiiOrchestrator.${categoryId}.name`;
}

// ─── Display helpers ─────────────────────────────────────────────────────────

/** @see formatModelNameFull — display normalization preserving trailing dates */
export function prettifyModelName(raw: string): string {
  return formatModelNameFull(raw);
}

/**
 * Build a short model summary string from a category's models list.
 * Shows first N prettified names, then "+ X more" if truncated.
 */
export function summarizeModelNames(
  models: string[],
  maxVisible: number = 3
): { visible: string[]; remaining: number } {
  const names = models.map(prettifyModelName);
  if (names.length <= maxVisible) {
    return { visible: names, remaining: 0 };
  }
  return {
    visible: names.slice(0, maxVisible),
    remaining: names.length - maxVisible,
  };
}

// ─── API-driven helpers ──────────────────────────────────────────────────────

/**
 * Whether an agent type is a proxy (not direct).
 * Proxy listings are restricted from the highest category (pro_max).
 */
export function isProxyAgentType(
  agentType: string,
  config: ORGIIPoolConfig
): boolean {
  return !config.direct_agent_types.includes(agentType);
}

/**
 * Whether a model belongs to the highest (most expensive) category.
 * Proxy accounts cannot direct-list these models.
 */
export function isHighestCategoryModel(
  modelName: string,
  config: ORGIIPoolConfig
): boolean {
  return (
    classifyModelFromConfig(modelName, config) === config.highest_category_id
  );
}

/**
 * Split a list of models into direct-listable vs pool-only.
 * For proxy accounts, models in the highest category (e.g. pro_max) are
 * pool-only — they can only be sold via the ORGII pool, not direct-listed.
 * Non-proxy accounts get all models as direct.
 */
export function splitModelsByCategory(
  models: string[],
  config: ORGIIPoolConfig,
  isProxy: boolean
): { directModels: string[]; poolOnlyModels: string[] } {
  if (!isProxy) {
    return { directModels: models, poolOnlyModels: [] };
  }
  const direct: string[] = [];
  const poolOnly: string[] = [];
  for (const model of models) {
    if (isHighestCategoryModel(model, config)) {
      poolOnly.push(model);
    } else {
      direct.push(model);
    }
  }
  return { directModels: direct, poolOnlyModels: poolOnly };
}

export function classifyModelFromConfig(
  modelName: string,
  config: ORGIIPoolConfig
): string {
  const lower = modelName.toLowerCase();
  const allPatterns: Array<{ pattern: string; catId: string }> = [];
  for (const cat of config.categories) {
    for (const model of cat.models) {
      allPatterns.push({ pattern: model.toLowerCase(), catId: cat.id });
    }
  }
  allPatterns.sort((a, b) => b.pattern.length - a.pattern.length);

  for (const { pattern, catId } of allPatterns) {
    if (lower.includes(pattern)) return catId;
  }
  return (
    config.categories[Math.floor(config.categories.length / 2)]?.id ??
    config.categories[0]?.id ??
    ""
  );
}
