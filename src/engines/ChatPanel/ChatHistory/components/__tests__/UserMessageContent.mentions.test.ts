import { describe, expect, it } from "vitest";

import { parseUserMessage, splitMentionSegments } from "../UserMessageContent";

const mentions = [
  { userId: "u-vince", displayName: "VantaNode" },
  { userId: "u-ann", displayName: "Ann" },
  { userId: "u-ann-lee", displayName: "Ann Lee" },
];

describe("splitMentionSegments", () => {
  it("turns a pill-inserted @name into a mention segment", () => {
    const segments = splitMentionSegments(
      parseUserMessage("@VantaNode  please check your inbox"),
      mentions
    );
    expect(segments).toEqual([
      { kind: "mention", userId: "u-vince", displayName: "VantaNode" },
      { kind: "text", text: "  please check your inbox" },
    ]);
  });

  it("matches the longest name first and keeps surrounding text", () => {
    const segments = splitMentionSegments(
      parseUserMessage("ping @Ann Lee and @ann now"),
      mentions
    );
    expect(segments).toEqual([
      { kind: "text", text: "ping " },
      { kind: "mention", userId: "u-ann-lee", displayName: "Ann Lee" },
      { kind: "text", text: " and " },
      { kind: "mention", userId: "u-ann", displayName: "Ann" },
      { kind: "text", text: " now" },
    ]);
  });

  it("leaves emails, unknown names and messages without mentions alone", () => {
    const text = "mail me@ann.dev or ask @nobody";
    expect(splitMentionSegments(parseUserMessage(text), mentions)).toEqual([
      { kind: "text", text },
    ]);
    expect(splitMentionSegments(parseUserMessage("plain"), [])).toEqual([
      { kind: "text", text: "plain" },
    ]);
  });
});
