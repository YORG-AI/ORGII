import { describe, expect, it } from "vitest";

import {
  buildTeamChatMentionOptions,
  hasUnsupportedTeamChatAudiencePill,
  isTeamChatBodyWithinLimit,
  isTeamChatMentionAudienceWithinLimit,
  resolveTeamChatAudienceTargets,
  resolveTeamChatMentionedUserIds,
  resolveTeamChatMentions,
} from "./teamChatMentions";

const members = [
  { userId: "u-ann", displayName: "Ann", role: "member" },
  { userId: "u-ann-lee", displayName: "Ann Lee", role: "owner" },
  { userId: "u-vince", displayName: "VantaNode", role: "admin" },
  { userId: "u-blank", displayName: "   ", role: "member" },
];

describe("buildTeamChatMentionOptions", () => {
  it("lists every other member by display name, falling back to the id", () => {
    const options = buildTeamChatMentionOptions(members, "u-vince", "Team");
    expect(options.map((option) => option.label)).toEqual([
      "all",
      "Ann",
      "Ann Lee",
      "u-blank",
    ]);
    expect(options[0]).toEqual({
      id: "team-chat:all",
      label: "all",
      groupLabel: "Team",
      audienceTarget: { kind: "all" },
    });
    expect(options[1]).toEqual({
      id: "u-ann",
      label: "Ann",
      description: "member",
      groupLabel: "Team",
      audienceTarget: { kind: "member", id: "u-ann" },
    });
  });

  it("does not offer @all when the explicit-recipient wire cannot carry it", () => {
    const largeRoster = Array.from({ length: 52 }, (_, index) => ({
      userId: `user-${index}`,
      displayName: `User ${index}`,
      role: "member",
    }));
    expect(
      buildTeamChatMentionOptions(largeRoster, "user-0", "Team").some(
        (option) => option.audienceTarget?.kind === "all"
      )
    ).toBe(false);
  });
});

describe("resolveTeamChatMentions", () => {
  it("resolves pill-inserted full names, longest label first", () => {
    expect(resolveTeamChatMentions("@Ann Lee can you look?", members)).toEqual([
      "u-ann-lee",
    ]);
    expect(resolveTeamChatMentions("@Ann can you look?", members)).toEqual([
      "u-ann",
    ]);
  });

  it("resolves hand-typed tokens case-insensitively against name or id", () => {
    expect(
      resolveTeamChatMentions("ping @vantanode and @u-ann!", members)
    ).toEqual(["u-vince", "u-ann"]);
  });

  it("dedupes and keeps first-appearance order", () => {
    expect(
      resolveTeamChatMentions("@VantaNode @Ann @VantaNode", members)
    ).toEqual(["u-vince", "u-ann"]);
  });

  it("ignores emails, unknown names and mid-word at signs", () => {
    expect(
      resolveTeamChatMentions("mail me@ann.dev or ask @nobody", members)
    ).toEqual([]);
    expect(resolveTeamChatMentions("no mentions here", members)).toEqual([]);
  });
});

describe("resolveTeamChatAudienceTargets", () => {
  it("keeps a pill's stable user id when its display label is ambiguous", () => {
    expect(
      resolveTeamChatAudienceTargets("@Ann please review", members, {
        parts: [
          {
            kind: "pill",
            attrs: {
              filePath: "member://u-ann-lee",
              fileName: "Ann",
              isFolder: false,
              iconType: "member",
              lineStart: null,
              lineEnd: null,
            },
          },
          { kind: "text", text: " please review" },
        ],
      })
    ).toEqual([{ kind: "member", id: "u-ann-lee" }]);
  });

  it("supports typed @all and expands notifications to every other member", () => {
    expect(
      resolveTeamChatAudienceTargets("@all please review", members)
    ).toEqual([{ kind: "all" }]);
    expect(
      resolveTeamChatMentionedUserIds(
        "@all please review",
        members,
        undefined,
        "u-vince"
      )
    ).toEqual(["u-ann", "u-ann-lee", "u-blank"]);
  });

  it("surfaces an oversized @all audience before the Cloud request", () => {
    const largeRoster = Array.from({ length: 52 }, (_, index) => ({
      userId: `user-${index}`,
      displayName: `User ${index}`,
    }));
    const recipients = resolveTeamChatMentionedUserIds(
      "@all please review",
      largeRoster,
      undefined,
      "user-0"
    );
    expect(recipients).toHaveLength(51);
    expect(isTeamChatMentionAudienceWithinLimit(recipients)).toBe(false);
  });

  it("rejects structured member ids outside the current Cloud roster", () => {
    expect(
      resolveTeamChatMentionedUserIds("@Reviewer please review", members, {
        parts: [
          {
            kind: "pill",
            attrs: {
              filePath: "member://agent-org-member-9",
              fileName: "Reviewer",
              isFolder: false,
              iconType: "member",
              lineStart: null,
              lineEnd: null,
            },
          },
          { kind: "text", text: " please review" },
        ],
      })
    ).toEqual([]);
  });

  it("never treats Agent or Agent Org pills as Team Chat audience", () => {
    const snapshot = {
      parts: [
        {
          kind: "pill" as const,
          attrs: {
            filePath: "agent://reviewer",
            fileName: "Reviewer",
            isFolder: false,
            iconType: "member" as const,
            lineStart: null,
            lineEnd: null,
          },
        },
        {
          kind: "pill" as const,
          attrs: {
            filePath: "agent_org://review-team",
            fileName: "Review team",
            isFolder: false,
            iconType: "member" as const,
            lineStart: null,
            lineEnd: null,
          },
        },
        { kind: "text" as const, text: " please review" },
      ],
    };

    expect(resolveTeamChatAudienceTargets("", members, snapshot)).toEqual([]);
    expect(hasUnsupportedTeamChatAudiencePill(snapshot)).toBe(true);
  });
});

describe("isTeamChatBodyWithinLimit", () => {
  it("mirrors the 4000-code-point Cloud comment limit", () => {
    expect(isTeamChatBodyWithinLimit("a".repeat(4000))).toBe(true);
    expect(isTeamChatBodyWithinLimit("😀".repeat(4000))).toBe(true);
    expect(isTeamChatBodyWithinLimit("a".repeat(4001))).toBe(false);
  });
});
