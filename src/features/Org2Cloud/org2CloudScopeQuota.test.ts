import { describe, expect, it } from "vitest";

import {
  coolingDaysLeft,
  deriveScopeQuotaView,
  parseScopeCooldownFreesAt,
} from "./org2CloudScopeQuota";
import type { CloudOrgScopeState } from "./org2CloudSyncClient";

const NOW = Date.parse("2026-07-04T00:00:00.000Z");

function makeState(
  overrides: Partial<CloudOrgScopeState> = {}
): CloudOrgScopeState {
  return {
    repoScopes: ["github.com/acme/alpha"],
    used: 1,
    cap: 3,
    cooldownDays: 7,
    coolingDown: [],
    ...overrides,
  };
}

describe("coolingDaysLeft", () => {
  it("ceils partial days", () => {
    expect(coolingDaysLeft("2026-07-05T06:00:00.000Z", NOW)).toBe(2);
  });

  it("never reports less than one day", () => {
    expect(coolingDaysLeft("2026-07-04T00:30:00.000Z", NOW)).toBe(1);
    expect(coolingDaysLeft("2026-07-01T00:00:00.000Z", NOW)).toBe(1);
    expect(coolingDaysLeft("not-a-date", NOW)).toBe(1);
  });
});

describe("deriveScopeQuotaView", () => {
  it("renders used/cap and flags at-cap on capped plans", () => {
    const under = deriveScopeQuotaView({
      scopeState: makeState({ used: 2, cap: 3 }),
      draft: [],
      now: NOW,
    });
    expect(under.counterLabel).toBe("2/3");
    expect(under.atCap).toBe(false);

    const at = deriveScopeQuotaView({
      scopeState: makeState({ used: 3, cap: 3 }),
      draft: [],
      now: NOW,
    });
    expect(at.counterLabel).toBe("3/3");
    expect(at.atCap).toBe(true);
  });

  it("renders bare used (never at cap) on unlimited plans", () => {
    const view = deriveScopeQuotaView({
      scopeState: makeState({ used: 9, cap: null }),
      draft: [],
      now: NOW,
    });
    expect(view.counterLabel).toBe("9");
    expect(view.atCap).toBe(false);
  });

  it("counts occupancy, not the active list (cooling slots included)", () => {
    // 1 active scope + 2 cooling slots ⇒ used 3 exceeds the visible list.
    const view = deriveScopeQuotaView({
      scopeState: makeState({
        used: 3,
        cap: 3,
        coolingDown: [
          {
            scopeKey: "github.com/acme/beta",
            freesAt: "2026-07-06T12:00:00.000Z",
          },
          {
            scopeKey: "github.com/acme/gamma",
            freesAt: "2026-07-11T00:00:00.000Z",
          },
        ],
      }),
      draft: ["github.com/acme/alpha"],
      now: NOW,
    });
    expect(view.atCap).toBe(true);
    expect(view.coolingRows).toEqual([
      { scopeKey: "github.com/acme/beta", daysLeft: 3 },
      { scopeKey: "github.com/acme/gamma", daysLeft: 7 },
    ]);
  });

  it("hides cooling rows the user re-drafted as active scopes", () => {
    const view = deriveScopeQuotaView({
      scopeState: makeState({
        used: 2,
        coolingDown: [
          {
            scopeKey: "github.com/acme/beta",
            freesAt: "2026-07-06T00:00:00.000Z",
          },
        ],
      }),
      draft: ["github.com/acme/alpha", "github.com/acme/beta"],
      now: NOW,
    });
    expect(view.coolingRows).toEqual([]);
  });
});

describe("parseScopeCooldownFreesAt", () => {
  it("recovers the ISO frees-at suffix", () => {
    const parsed = parseScopeCooldownFreesAt(
      "ORG2_SCOPE_COOLDOWN 2026-07-11T00:00:00Z"
    );
    expect(parsed?.toISOString()).toBe("2026-07-11T00:00:00.000Z");
  });

  it("returns null for a missing or malformed suffix", () => {
    expect(parseScopeCooldownFreesAt("ORG2_SCOPE_COOLDOWN")).toBeNull();
    expect(
      parseScopeCooldownFreesAt("ORG2_SCOPE_COOLDOWN soon-ish")
    ).toBeNull();
    expect(parseScopeCooldownFreesAt("ORG2_FORBIDDEN")).toBeNull();
  });
});
