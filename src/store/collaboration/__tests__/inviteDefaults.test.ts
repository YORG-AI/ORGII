import { describe, expect, it } from "vitest";

import {
  BOOTSTRAP_INVITE_USAGE_LIMIT,
  DEFAULT_INVITE_EXPIRY_DAYS,
  INVITE_KIND,
  PANEL_INVITE_USAGE_LIMIT,
  createInviteDefaults,
  getInviteExpiresAt,
} from "../inviteDefaults";
import { COLLAB_ROLE } from "../types";

const NOW = new Date("2026-07-01T00:00:00.000Z");

describe("createInviteDefaults", () => {
  it("keeps the bootstrap invite multi-use: 10 uses / 7 days (design §8.1)", () => {
    const defaults = createInviteDefaults(INVITE_KIND.BOOTSTRAP, NOW);
    expect(defaults.usageLimit).toBe(10);
    expect(defaults.usageLimit).toBe(BOOTSTRAP_INVITE_USAGE_LIMIT);
    expect(defaults.expiresAt).toBe("2026-07-08T00:00:00.000Z");
    expect(defaults.role).toBe(COLLAB_ROLE.MEMBER);
  });

  it("defaults panel-created invites to single-use / 7 days (design §8.1)", () => {
    const defaults = createInviteDefaults(INVITE_KIND.PANEL, NOW);
    expect(defaults.usageLimit).toBe(1);
    expect(defaults.usageLimit).toBe(PANEL_INVITE_USAGE_LIMIT);
    expect(defaults.expiresAt).toBe("2026-07-08T00:00:00.000Z");
    expect(defaults.role).toBe(COLLAB_ROLE.MEMBER);
  });

  it("shares one 7-day expiry default across both tiers", () => {
    expect(DEFAULT_INVITE_EXPIRY_DAYS).toBe(7);
  });
});

describe("getInviteExpiresAt", () => {
  it("adds whole days to the reference time", () => {
    expect(getInviteExpiresAt(1, NOW)).toBe("2026-07-02T00:00:00.000Z");
    expect(getInviteExpiresAt(30, NOW)).toBe("2026-07-31T00:00:00.000Z");
  });
});
