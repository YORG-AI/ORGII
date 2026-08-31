import { describe, expect, it } from "vitest";

import {
  buildTeamChatMentionOptions,
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
      "Ann",
      "Ann Lee",
      "u-blank",
    ]);
    expect(options[0]).toEqual({
      id: "u-ann",
      label: "Ann",
      description: "member",
      groupLabel: "Team",
    });
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
