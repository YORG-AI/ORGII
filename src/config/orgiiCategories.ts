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
import "@src/icons";
import "@src/icons";
import type { ORGIIPoolCategory } from "@src/types/model/pool";
import "@src/util/formatModelName";

// ─── ORGII tier constants ─────────────────────────────────────────────────────

const ORGII_TIER_PREFIX = "orgii:";

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

// ─── Display helpers ─────────────────────────────────────────────────────────

// ─── API-driven helpers ──────────────────────────────────────────────────────
