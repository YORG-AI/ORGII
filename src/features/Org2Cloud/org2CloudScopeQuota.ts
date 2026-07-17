/**
 * Pure derivations for repo-scope governance (quota + cooldown) so
 * `CloudOrgPanelView` stays thin. Server truth is `CloudOrgScopeState`
 * (`cloud_get_org_repo_scopes`): `used` is OCCUPANCY (active + cooling
 * slots), which is why the counter can exceed the visible scope list.
 */
import type { CloudOrgScopeState } from "./org2CloudSyncClient";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ScopeQuotaCoolingRow {
  scopeKey: string;
  /** Whole days until the slot frees (ceil, floored at 1). */
  daysLeft: number;
}

export interface ScopeQuotaView {
  used: number;
  cap: number | null;
  /** "used/cap", or just "used" on unlimited plans. */
  counterLabel: string;
  atCap: boolean;
  coolingRows: ScopeQuotaCoolingRow[];
}

/** Days until `freesAt` — ceil, min 1 (a slot never shows "0 days"). */
export function coolingDaysLeft(freesAt: string, now: number): number {
  const freesAtMs = Date.parse(freesAt);
  if (Number.isNaN(freesAtMs)) return 1;
  return Math.max(1, Math.ceil((freesAtMs - now) / DAY_MS));
}

export function deriveScopeQuotaView({
  scopeState,
  draft,
  now = Date.now(),
}: {
  scopeState: CloudOrgScopeState;
  draft: string[];
  now?: number;
}): ScopeQuotaView {
  const { used, cap } = scopeState;
  const draftKeys = new Set(draft);
  return {
    used,
    cap,
    counterLabel: cap === null ? String(used) : `${used}/${cap}`,
    atCap: cap !== null && used >= cap,
    // A cooling scope the user re-drafted already renders as an active row;
    // don't show it twice.
    coolingRows: scopeState.coolingDown
      .filter((entry) => !draftKeys.has(entry.scopeKey))
      .map((entry) => ({
        scopeKey: entry.scopeKey,
        daysLeft: coolingDaysLeft(entry.freesAt, now),
      })),
  };
}

/**
 * Recover the frees-at timestamp from an `ORG2_SCOPE_COOLDOWN <ISO>` error
 * message. Returns null when the suffix is missing or unparseable — callers
 * fall back to a date-less message.
 */
export function parseScopeCooldownFreesAt(message: string): Date | null {
  const match = /ORG2_SCOPE_COOLDOWN\s+(\S+)/.exec(message);
  if (!match) return null;
  const parsed = new Date(match[1]);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
