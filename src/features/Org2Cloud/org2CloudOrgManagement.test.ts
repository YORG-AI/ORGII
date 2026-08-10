import { describe, expect, it } from "vitest";

import { ORG2_CLOUD_OFFICIAL_SUPABASE_URL } from "./config";
import {
  CLOUD_ASSIGNABLE_ROLES,
  CLOUD_INVITE_STATE,
  CLOUD_INVITE_WEB_BASE_URL,
  type CloudMemberLike,
  buildCloudInviteLink,
  buildCloudSessionShareLink,
  cloudManagementErrorKey,
  cloudManagementErrorMessage,
  countOtherActiveAdmins,
  deriveCloudInviteState,
  extractOrg2ManagementErrorCode,
  generateCloudInviteCode,
  getCloudInviteRemainingUses,
  isCloudAssignableRole,
  isCloudInviteDeepLink,
  isCloudShareDeepLink,
  parseCloudInviteDeepLink,
  parseCloudInviteInput,
  parseCloudShareDeepLink,
  parseCloudShareInput,
  sha256Hex,
  wouldRemoveLastAdmin,
} from "./org2CloudOrgManagement";

describe("cloud assignable roles", () => {
  it("only exposes admin and member", () => {
    expect(CLOUD_ASSIGNABLE_ROLES).toEqual(["admin", "member"]);
    expect(isCloudAssignableRole("admin")).toBe(true);
    expect(isCloudAssignableRole("member")).toBe(true);
    expect(isCloudAssignableRole("viewer")).toBe(false);
    expect(isCloudAssignableRole("owner")).toBe(false);
  });
});

describe("invite code generation + hashing", () => {
  it("mints 64-char lowercase hex codes (32 bytes of entropy)", () => {
    const code = generateCloudInviteCode();
    expect(code).toMatch(/^[0-9a-f]{64}$/);
    // Two mints must differ (probability of collision ~2^-256).
    expect(generateCloudInviteCode()).not.toBe(code);
  });

  it("sha256Hex matches the NIST 'abc' test vector", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

describe("cloud invite deep link", () => {
  it("builds a shareable HTTPS link with the invite kept in the fragment", () => {
    const inviteCode = "c0de".repeat(16);
    const link = buildCloudInviteLink(inviteCode);
    expect(link).toBe(`${CLOUD_INVITE_WEB_BASE_URL}#invite=${inviteCode}`);
    expect(new URL(link).search).toBe("");
    expect(isCloudInviteDeepLink(link)).toBe(false);
  });

  it("rejects collaboration links and foreign schemes", () => {
    expect(isCloudInviteDeepLink("orgii://collaboration/join?invite=x")).toBe(
      false
    );
    expect(parseCloudInviteDeepLink("yorgai://cloud/join?invite=x")).toBeNull();
    expect(parseCloudInviteDeepLink("not a url")).toBeNull();
  });

  it("returns null for a cloud link without a code", () => {
    expect(parseCloudInviteDeepLink("orgii://cloud/join")).toBeNull();
    expect(parseCloudInviteDeepLink("orgii://cloud/join?invite=")).toBeNull();
  });

  it("parseCloudInviteInput accepts raw codes and links alike", () => {
    const fragmentCode = "f".repeat(64);
    const queryCode = "0".repeat(64);
    expect(parseCloudInviteInput("  rawcode  ")).toBe("rawcode");
    expect(parseCloudInviteInput("orgii://cloud/join?invite=abc")).toBe("abc");
    expect(
      parseCloudInviteInput(
        `${CLOUD_INVITE_WEB_BASE_URL}#invite=${fragmentCode}`
      )
    ).toBe(fragmentCode);
    expect(
      parseCloudInviteInput(`${CLOUD_INVITE_WEB_BASE_URL}?invite=${queryCode}`)
    ).toBe(queryCode);
    expect(
      parseCloudInviteInput(
        `${CLOUD_INVITE_WEB_BASE_URL}?invite=${queryCode}#invite=${fragmentCode}`
      )
    ).toBe(fragmentCode);
    expect(
      parseCloudInviteInput(
        `${CLOUD_INVITE_WEB_BASE_URL}?invite=${queryCode}#invite=`
      )
    ).toBe(queryCode);
    // Same 64-hex contract as the handoff page: uppercase normalizes,
    // non-hex codes on the right origin are rejected.
    expect(
      parseCloudInviteInput(
        `${CLOUD_INVITE_WEB_BASE_URL}#invite=${fragmentCode.toUpperCase()}`
      )
    ).toBe(fragmentCode);
    expect(
      parseCloudInviteInput(`${CLOUD_INVITE_WEB_BASE_URL}#invite=not-a-code`)
    ).toBeNull();
    expect(parseCloudInviteInput("")).toBeNull();
    // An orgii:// link that is NOT a cloud invite must not fall through to
    // being treated as a raw code.
    expect(
      parseCloudInviteInput("orgii://collaboration/join?invite=abc")
    ).toBeNull();
    expect(parseCloudInviteInput("https://example.com/#invite=abc")).toBeNull();
    expect(parseCloudInviteInput("ftp://example.com/invite")).toBeNull();
  });
});

describe("cloud session share deep link (0012)", () => {
  it("builds and parses a round-trip link", () => {
    const token = "a".repeat(64);
    const link = buildCloudSessionShareLink(token);
    expect(link).toBe(`orgii://cloud/session?share=${token}&endpoint=official`);
    expect(isCloudShareDeepLink(link)).toBe(true);
    expect(parseCloudShareDeepLink(link)).toEqual({
      shareToken: token,
      endpoint: { kind: "official" },
    });
  });

  it("normalizes an override pointing at the OFFICIAL deployment to official", () => {
    const token = "d".repeat(64);
    const link = buildCloudSessionShareLink(token, {
      isOfficial: false,
      supabaseUrl: `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/`,
    });
    expect(link).toBe(`orgii://cloud/session?share=${token}&endpoint=official`);
    expect(parseCloudShareDeepLink(link)).toEqual({
      shareToken: token,
      endpoint: { kind: "official" },
    });
  });

  it("heals already-minted custom links whose URL is the official deployment", () => {
    const token = "e".repeat(64);
    const link = `orgii://cloud/session?share=${token}&endpoint=custom&endpointUrl=${encodeURIComponent(
      ORG2_CLOUD_OFFICIAL_SUPABASE_URL
    )}`;
    expect(parseCloudShareDeepLink(link)).toEqual({
      shareToken: token,
      endpoint: { kind: "official" },
    });
  });

  it("round-trips custom endpoint provenance without credentials", () => {
    const token = "b".repeat(64);
    const link = buildCloudSessionShareLink(token, {
      isOfficial: false,
      supabaseUrl: "https://cloud.example.com/",
    });
    expect(link).not.toContain("anon");
    expect(parseCloudShareDeepLink(link)).toEqual({
      shareToken: token,
      endpoint: {
        kind: "custom",
        supabaseUrl: "https://cloud.example.com",
      },
    });
  });

  it("treats pre-provenance links as official and rejects unsafe custom URLs", () => {
    const token = "c".repeat(64);
    expect(
      parseCloudShareDeepLink(`orgii://cloud/session?share=${token}`)
    ).toEqual({ shareToken: token, endpoint: { kind: "official" } });
    expect(
      parseCloudShareDeepLink(
        `orgii://cloud/session?share=${token}&endpoint=custom&endpointUrl=http%3A%2F%2Fevil.example.com`
      )
    ).toBeNull();
  });

  it("share and join links never cross-parse", () => {
    expect(isCloudShareDeepLink("orgii://cloud/join?invite=x")).toBe(false);
    expect(parseCloudShareDeepLink("orgii://cloud/join?invite=x")).toBeNull();
    expect(isCloudInviteDeepLink("orgii://cloud/session?share=x")).toBe(false);
    // Self-hosted collaboration share links stay on their own host.
    expect(isCloudShareDeepLink("orgii://collaboration/session?share=x")).toBe(
      false
    );
  });

  it("returns null for malformed or tokenless links", () => {
    expect(parseCloudShareDeepLink("orgii://cloud/session")).toBeNull();
    expect(parseCloudShareDeepLink("orgii://cloud/session?share=")).toBeNull();
    expect(
      parseCloudShareDeepLink("yorgai://cloud/session?share=x")
    ).toBeNull();
    expect(parseCloudShareDeepLink("not a url")).toBeNull();
  });

  it("parseCloudShareInput accepts a full share link", () => {
    const token = "f".repeat(64);
    expect(parseCloudShareInput(buildCloudSessionShareLink(token))).toEqual({
      shareToken: token,
      endpoint: { kind: "official" },
    });
    expect(
      parseCloudShareInput(`  ${buildCloudSessionShareLink(token)}  `)
    ).toEqual({ shareToken: token, endpoint: { kind: "official" } });
  });

  it("parseCloudShareInput accepts a bare 64-char hex token", () => {
    const token = "0123456789abcdef".repeat(4);
    expect(parseCloudShareInput(token)).toEqual({
      shareToken: token,
      endpoint: { kind: "current" },
    });
    expect(parseCloudShareInput(`  ${token}\n`)).toEqual({
      shareToken: token,
      endpoint: { kind: "current" },
    });
  });

  it("parseCloudShareInput rejects garbage", () => {
    expect(parseCloudShareInput("")).toBeNull();
    expect(parseCloudShareInput("   ")).toBeNull();
    expect(parseCloudShareInput("hello world")).toBeNull();
    expect(parseCloudShareInput("a".repeat(63))).toBeNull();
    expect(parseCloudShareInput("a".repeat(65))).toBeNull();
    expect(parseCloudShareInput("A".repeat(64))).toBeNull();
    expect(parseCloudShareInput("g".repeat(64))).toBeNull();
    expect(parseCloudShareInput("orgii://cloud/join?invite=abc")).toBeNull();
    expect(parseCloudShareInput("orgii://cloud/session?share=")).toBeNull();
    expect(
      parseCloudShareInput("orgii://collaboration/session?share=x")
    ).toBeNull();
  });
});

describe("invite state derivation", () => {
  const NOW = Date.parse("2026-07-04T12:00:00Z");
  const base = {
    maxUses: 5,
    usedCount: 0,
    expiresAt: undefined as string | undefined,
    revokedAt: undefined as string | undefined,
  };

  it("active invite reports remaining uses", () => {
    expect(deriveCloudInviteState(base, NOW)).toBe(CLOUD_INVITE_STATE.ACTIVE);
    expect(getCloudInviteRemainingUses({ maxUses: 5, usedCount: 2 })).toBe(3);
  });

  it("remaining uses never goes negative", () => {
    expect(getCloudInviteRemainingUses({ maxUses: 5, usedCount: 9 })).toBe(0);
  });

  it("revoked wins over everything", () => {
    expect(
      deriveCloudInviteState(
        {
          ...base,
          revokedAt: "2026-07-01T00:00:00Z",
          usedCount: 5,
          expiresAt: "2026-01-01T00:00:00Z",
        },
        NOW
      )
    ).toBe(CLOUD_INVITE_STATE.REVOKED);
  });

  it("expired wins over exhausted (server accept_invite check order)", () => {
    expect(
      deriveCloudInviteState(
        { ...base, usedCount: 5, expiresAt: "2026-01-01T00:00:00Z" },
        NOW
      )
    ).toBe(CLOUD_INVITE_STATE.EXPIRED);
  });

  it("exhausted when used_count reaches max_uses", () => {
    expect(deriveCloudInviteState({ ...base, usedCount: 5 }, NOW)).toBe(
      CLOUD_INVITE_STATE.EXHAUSTED
    );
  });

  it("a future expiry stays active", () => {
    expect(
      deriveCloudInviteState(
        { ...base, expiresAt: "2026-12-31T00:00:00Z" },
        NOW
      )
    ).toBe(CLOUD_INVITE_STATE.ACTIVE);
  });
});

describe("last-admin pre-check", () => {
  const members: CloudMemberLike[] = [
    { userId: "u-owner", role: "owner", status: "active" },
    { userId: "u-admin", role: "admin", status: "active" },
    { userId: "u-member", role: "member", status: "active" },
    { userId: "u-removed-admin", role: "admin", status: "removed" },
  ];

  it("counts active owner/admin members excluding the target", () => {
    expect(countOtherActiveAdmins(members, "u-admin")).toBe(1); // the owner
    expect(countOtherActiveAdmins(members, "u-member")).toBe(2);
  });

  it("removing a plain member never trips the guard", () => {
    expect(wouldRemoveLastAdmin(members, "u-member")).toBe(false);
  });

  it("removing an admin is fine while the owner remains", () => {
    expect(wouldRemoveLastAdmin(members, "u-admin")).toBe(false);
  });

  it("flags the last remaining admin (owner counts as admin)", () => {
    const soloAdmin: CloudMemberLike[] = [
      { userId: "u-admin", role: "admin", status: "active" },
      { userId: "u-member", role: "member", status: "active" },
    ];
    expect(wouldRemoveLastAdmin(soloAdmin, "u-admin")).toBe(true);
  });

  it("removed admins do not count toward the surviving-admin set", () => {
    const withGhost: CloudMemberLike[] = [
      { userId: "u-admin", role: "admin", status: "active" },
      { userId: "u-removed-admin", role: "admin", status: "removed" },
    ];
    expect(wouldRemoveLastAdmin(withGhost, "u-admin")).toBe(true);
  });

  it("ignores a target that is not an active member", () => {
    expect(wouldRemoveLastAdmin(members, "u-removed-admin")).toBe(false);
    expect(wouldRemoveLastAdmin(members, "u-unknown")).toBe(false);
  });
});

describe("management error codes", () => {
  it("extracts codes from server messages (suffix payload tolerated)", () => {
    expect(extractOrg2ManagementErrorCode("ORG2_LAST_ADMIN")).toBe(
      "ORG2_LAST_ADMIN"
    );
    expect(
      extractOrg2ManagementErrorCode("ORG2_OWNER_HAS_MEMBERS org-1,org-2")
    ).toBeNull(); // not a management-surface code
    expect(extractOrg2ManagementErrorCode("something else")).toBeNull();
  });

  it("never lets a short code shadow a longer sibling", () => {
    expect(extractOrg2ManagementErrorCode("ORG2_MEMBER_NOT_FOUND")).toBe(
      "ORG2_MEMBER_NOT_FOUND"
    );
    expect(extractOrg2ManagementErrorCode("ORG2_ORG_NOT_FOUND")).toBe(
      "ORG2_ORG_NOT_FOUND"
    );
    expect(extractOrg2ManagementErrorCode("ORG2_NOT_FOUND")).toBe(
      "ORG2_NOT_FOUND"
    );
  });

  it.each([
    ["ORG2_LAST_ADMIN", "cloud.orgManagement.errors.lastAdmin"],
    [
      "ORG2_OWNER_MUST_TRANSFER",
      "cloud.orgManagement.errors.ownerMustTransfer",
    ],
    ["ORG2_OWNER_REQUIRED", "cloud.orgManagement.errors.ownerRequired"],
    ["ORG2_ADMIN_REQUIRED", "cloud.orgManagement.errors.adminRequired"],
    ["ORG2_QUOTA_EXCEEDED", "cloud.orgManagement.errors.quotaExceeded"],
    ["ORG2_FORBIDDEN", "cloud.orgManagement.errors.forbidden"],
    ["ORG2_MEMBER_NOT_FOUND", "cloud.orgManagement.errors.memberNotFound"],
    ["ORG2_ALREADY_MEMBER", "cloud.orgManagement.errors.alreadyMember"],
    ["ORG2_INVITE_INVALID", "cloud.orgManagement.errors.inviteInvalid"],
    ["ORG2_INVITE_REVOKED", "cloud.orgManagement.errors.inviteRevoked"],
    ["ORG2_INVITE_EXPIRED", "cloud.orgManagement.errors.inviteExpired"],
    ["ORG2_INVITE_EXHAUSTED", "cloud.orgManagement.errors.inviteExhausted"],
    ["ORG2_VALIDATION", "cloud.orgManagement.errors.validation"],
  ])("maps %s to its i18n key", (code, key) => {
    expect(cloudManagementErrorKey(new Error(code))).toBe(key);
  });

  it("falls back to the raw message for unrecognized errors", () => {
    const translate = (key: string) => `T(${key})`;
    expect(
      cloudManagementErrorMessage(new Error("ORG2_LAST_ADMIN"), translate)
    ).toBe("T(cloud.orgManagement.errors.lastAdmin)");
    expect(cloudManagementErrorMessage(new Error("boom"), translate)).toBe(
      "boom"
    );
    expect(cloudManagementErrorMessage("plain failure", translate)).toBe(
      "plain failure"
    );
  });

  it("maps fetch transport failures to the network message (not raw 'Load failed')", () => {
    const translate = (key: string) => `T(${key})`;
    expect(
      cloudManagementErrorMessage(new TypeError("Load failed"), translate)
    ).toBe("T(cloud.orgManagement.errors.network)");
    expect(
      cloudManagementErrorMessage(new TypeError("Failed to fetch"), translate)
    ).toBe("T(cloud.orgManagement.errors.network)");
    // A programming TypeError keeps its raw message.
    expect(
      cloudManagementErrorMessage(
        new TypeError("x is not a function"),
        translate
      )
    ).toBe("x is not a function");
  });
});
