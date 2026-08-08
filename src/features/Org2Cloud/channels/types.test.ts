import { describe, expect, it } from "vitest";

import { CloudChannelMembersSchema, CloudChannelsListSchema } from "./types";

const goodChannel = {
  id: "chan-1",
  name: "release-eng",
  visibility: "org",
  postPolicy: "everyone",
  createdAt: "2026-07-31T00:00:00Z",
  archivedAt: null,
  messageCount: 0,
  memberCount: 1,
  myRole: "manager",
};

describe("CloudChannelsListSchema", () => {
  it("drops a malformed row instead of rejecting the whole listing", () => {
    const parsed = CloudChannelsListSchema.parse({
      channels: [goodChannel, { id: 42, name: null }, "not-an-object"],
    });
    expect(parsed.channels).toHaveLength(1);
    expect(parsed.channels[0]?.id).toBe("chan-1");
  });
});

describe("CloudChannelMembersSchema", () => {
  it("drops a malformed member row, keeps the rest", () => {
    const parsed = CloudChannelMembersSchema.parse({
      members: [{ userId: "user-1", role: "member" }, { role: "member" }],
    });
    expect(parsed.members).toHaveLength(1);
    expect(parsed.members[0]?.userId).toBe("user-1");
  });
});
